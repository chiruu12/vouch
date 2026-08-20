// Check what the MCP tools actually put on the wire.
//
// `web/verify-output.mjs` holds the rendered pages to their promises. It cannot see this
// surface: the tools render on no page, so every guarantee about them was carried by
// tests over the functions rather than by anything watching the bytes a caller receives.
// An outside review found the gap the way gaps like this are always found. Promise E,
// "fixtures are always labelled synthetic", held on every page and on `recall_context`,
// and failed on `quarantined_for`, which returned a synthetic fixture recall with ref,
// full title, confidence and reason and nothing at all saying it was a fixture.
//
// So this drives the real server over stdio, exactly as an agent would, and checks the
// replies. Four rules, each one a promise the project makes in public:
//
//   1. A record from a synthetic source is never handed over unlabelled, in either
//      format. This is the one that failed.
//   2. No seller identity appears in any reply, in any tool, in either format.
//   3. A refusal leads its reply and carries a code to branch on, and nothing that could
//      be mistaken for an answer follows it.
//   4. The two formats agree about whether an answer was refused, and about absence. A
//      caller that switches format must not switch semantics. This covers the clean miss
//      that used to be stated plainly in the digest and silently in JSON.
//
//   node verify-tools.mjs
//
// Run from engine/. Reads web/public/snapshot.json, the artifact that actually ships.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT = new URL("../web/public/snapshot.json", import.meta.url).pathname;
const SAMPLES = new URL("./samples/", import.meta.url).pathname;

/** One stdio session: handshake, then every call, then read the replies back. */
async function callAll(calls) {
  const proc = spawn("node", ["--import", "tsx", "src/mcp.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    ...calls.map((c, i) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: i + 1,
        method: "tools/call",
        params: { name: c.tool, arguments: c.args },
      })
    ),
  ];
  proc.stdin.write(lines.join("\n") + "\n");
  proc.stdin.end();

  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  const code = await new Promise((res) => proc.on("close", res));
  if (code !== 0) {
    console.error(`the server exited ${code}. A gate cannot conclude anything from a server that died.`);
    console.error(err.slice(0, 2000));
    process.exit(2);
  }

  const byId = new Map();
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`the server wrote a line that is not JSON-RPC: ${line.slice(0, 200)}`);
      process.exit(2);
    }
    byId.set(msg.id, msg);
  }

  return calls.map((c, i) => {
    const msg = byId.get(i + 1);
    if (msg === undefined) {
      console.error(`no reply to ${c.tool} ${JSON.stringify(c.args)}. Refusing to pass on a missing answer.`);
      process.exit(2);
    }
    return { call: c, text: msg.result?.content?.[0]?.text ?? "", isError: msg.result?.isError === true };
  });
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const syntheticIds = snapshot.sources.filter((s) => s.synthetic).map((s) => s.id);
const syntheticRefs = snapshot.recalls
  .filter((r) => syntheticIds.includes(r.provenance.sourceId))
  .map((r) => r.ref);

if (syntheticIds.length === 0 || syntheticRefs.length === 0) {
  // A gate that can pass without exercising its own subject is worse than no gate. If
  // the snapshot ever stops carrying fixtures, rule 1 becomes vacuous and silently so.
  console.error("no synthetic source or no synthetic recall in the snapshot: rule 1 would prove nothing.");
  process.exit(2);
}

/** Queries chosen to reach a synthetic record through each tool that can return one. */
const syntheticTitle = snapshot.recalls.find((r) => syntheticRefs.includes(r.ref))?.title ?? "";
const nearMiss = "Iselin Kitchen 8L pressure cooker";

const CALLS = [
  { tool: "recall_context", args: { product: syntheticTitle } },
  { tool: "recall_context", args: { product: syntheticTitle, format: "json" } },
  { tool: "quarantined_for", args: { product: nearMiss } },
  { tool: "quarantined_for", args: { product: nearMiss, format: "json" } },
  { tool: "vouch_report", args: {} },
  { tool: "vouch_report", args: { format: "json" } },
  { tool: "breakage_report", args: {} },
  { tool: "breakage_report", args: { format: "json" } },
  { tool: "recall_context", args: { product: "ab" } },
  { tool: "recall_context", args: { product: "ab", format: "json" } },
  // A query that matches nothing while every recall source is vouched for: the strongest
  // claim this feed makes, and the one the JSON form used to leave out entirely.
  { tool: "recall_context", args: { product: "wireless bluetooth headphones" } },
  { tool: "recall_context", args: { product: "wireless bluetooth headphones", format: "json" } },
];

const replies = await callAll(CALLS);
const failures = [];
const note = (rule, call, why) =>
  failures.push(`${rule}: ${call.tool} ${JSON.stringify(call.args)}\n    ${why}`);

// --- 1. a synthetic record is never handed over unlabelled -------------------
let labelChecks = 0;
for (const { call, text } of replies) {
  const named = syntheticRefs.filter((ref) => text.includes(ref));
  if (named.length === 0) continue;
  labelChecks++;
  const labelled =
    text.includes("SYNTHETIC FIXTURE") || /"synthetic"\s*:\s*true/.test(text);
  if (!labelled) {
    note("rule 1 (synthetic labelling)", call, `names ${named.join(", ")} with no synthetic label`);
  }
}
if (labelChecks === 0) {
  console.error("rule 1 never fired: no reply carried a synthetic ref, so nothing was checked.");
  process.exit(2);
}

// --- 2. no seller identity, anywhere ----------------------------------------
// Values, not just field names. The published type has no seller field, so a hit here
// means one survived a spread nobody narrowed.
// Taken from the raw captures, not the snapshot. The snapshot has no seller field at
// all, which is the point, so searching it for seller keys would search for something
// that cannot be there and report a confident zero. The upstream captures are where the
// identities actually exist, and they are what a leak would be leaking.
const sellerKeys = new Set();
for (const file of readdirSync(SAMPLES)) {
  if (!file.endsWith(".json")) continue;
  for (const k of readFileSync(join(SAMPLES, file), "utf8").match(/sk_[0-9a-f]{6,}/g) ?? []) {
    sellerKeys.add(k);
  }
}
if (sellerKeys.size === 0) {
  console.error("no seller keys found in the captures: rule 2 would search for nothing.");
  process.exit(2);
}
for (const { call, text } of replies) {
  if (/sellerKey|sk_[0-9a-f]{6,}/i.test(text)) {
    note("rule 2 (seller identity)", call, "reply carries a seller key or field name");
  }
  for (const k of sellerKeys) {
    if (text.includes(k)) note("rule 2 (seller identity)", call, `reply carries seller key ${k}`);
  }
}

// --- 3. a refusal leads and carries a code ----------------------------------
for (const { call, text } of replies) {
  const isJson = call.args.format === "json";
  if (isJson) {
    if (!text.includes('"refused"')) continue;
    if (text.includes('"recalls"')) {
      note("rule 3 (refusal shape)", call, "a refusal arrived alongside a recalls array");
    }
    continue;
  }
  if (!text.includes("REFUSED")) continue;
  const first = text.split("\n")[0] ?? "";
  if (!first.startsWith("REFUSED ")) {
    note("rule 3 (refusal shape)", call, `refusal does not lead the reply: first line was "${first.slice(0, 60)}"`);
  }
  if (first.trim() === "REFUSED") {
    note("rule 3 (refusal shape)", call, "refusal carries no code to branch on");
  }
  if (/^(RECALL|NEAR) /m.test(text)) {
    note("rule 3 (refusal shape)", call, "a result line follows a refusal");
  }
}

// --- 4. the formats agree about refusal -------------------------------------
for (let i = 0; i < replies.length; i++) {
  const a = replies[i];
  if (a.call.args.format === "json") continue;
  const b = replies.find(
    (x) => x.call.tool === a.call.tool && x.call.args.format === "json" && x.call.args.product === a.call.args.product
  );
  if (b === undefined) continue;
  const digestRefused = a.text.startsWith("REFUSED");
  const jsonRefused = b.text.includes('"refused"');
  if (digestRefused !== jsonRefused) {
    note(
      "rule 4 (format parity)",
      a.call,
      `digest ${digestRefused ? "refused" : "answered"} while json ${jsonRefused ? "refused" : "answered"}`
    );
  }

  // Absence, stated or not stated, in both. NONE and `found: false` are the same claim.
  const digestNone = /^NONE /m.test(a.text);
  const jsonNone = /"found"\s*:\s*false/.test(b.text);
  if (digestNone !== jsonNone) {
    note(
      "rule 4 (format parity)",
      a.call,
      `digest ${digestNone ? "vouched for absence" : "did not"} while json ${jsonNone ? "did" : "did not"}`
    );
  }

  // And a refusal carries no tally in either form.
  if (digestRefused && /"withheld"/.test(b.text)) {
    note("rule 4 (format parity)", a.call, "json keeps a withheld tally the digest drops on a refusal");
  }
}

console.log(`tools driven          ${CALLS.length}`);
console.log(`synthetic replies     ${labelChecks}`);
console.log(`seller keys searched  ${sellerKeys.size}`);
console.log(`failures              ${failures.length}`);

if (failures.length > 0) {
  console.error("\n" + failures.map((f) => `  ${f}`).join("\n"));
  console.error("\nthe tool surface broke a promise the project makes in public.");
  process.exit(1);
}
console.log("\nok: every tool reply is labelled, carries no seller identity, and refuses in one shape");

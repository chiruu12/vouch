// What does one question cost to ask?
//
// The context service is read by something paying per token, so the size of an answer is
// a property of the product and not an implementation detail. This drives a real MCP
// session over stdio and measures what comes back, the same way verify-mutations.mjs
// breaks invariants rather than trusting that tests cover them.
//
//   node verify-tokens.mjs          measure, and fail if a budget is blown
//   node verify-tokens.mjs --show   print the payloads too
//
// Bytes, not tokens. Tokenisers differ per model and none of them are here, so a token
// count would be a guess dressed up as a measurement. Bytes are exact, reproducible and
// move with the thing we are trying to control. The estimates printed alongside use a
// stated divisor and are labelled as estimates.
//
// The split between fixed and per-query is the number that matters. Moving a constant
// out of every answer and into the session preamble makes a single-question session
// slightly worse and every real session better, and a harness that reported one total
// would have called that a regression.

import { spawn } from "node:child_process";

const BYTES_PER_TOKEN = 3.7; // rough, for cl100k-ish English with punctuation. An estimate.

const SESSION = [
  { id: 1, kind: "fixed", label: "initialize", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
  { id: 2, kind: "fixed", label: "tools/list", method: "tools/list" },
  { id: 3, kind: "query", label: "recall_context, one hit", method: "tools/call", params: { name: "recall_context", arguments: { product: "COMMOWNER pressure washer" } } },
  { id: 4, kind: "query", label: "recall_context, no match", method: "tools/call", params: { name: "recall_context", arguments: { product: "wireless bluetooth headphones" } } },
  { id: 5, kind: "query", label: "vouch_report", method: "tools/call", params: { name: "vouch_report", arguments: {} } },
  { id: 6, kind: "query", label: "breakage_report", method: "tools/call", params: { name: "breakage_report", arguments: {} } },
  { id: 7, kind: "info", label: "recall_context as json", method: "tools/call", params: { name: "recall_context", arguments: { product: "COMMOWNER pressure washer", format: "json" } } },
];

// Budgets. Set just above what the current implementation costs, so a change that makes
// an answer meaningfully more expensive has to be a deliberate one that moves the number
// here as well.
const BUDGET = { 1: 1300, 2: 1800, 3: 1200, 4: 200, 5: 200, 6: 300, 7: 1400 };

const show = process.argv.includes("--show");

const child = spawn("node", ["--import", "tsx", "src/mcp.ts"], { stdio: ["pipe", "pipe", "ignore"] });
for (const r of SESSION) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, method: r.method, ...(r.params ? { params: r.params } : {}) }) + "\n");
}
child.stdin.end();

let buf = "";
for await (const chunk of child.stdout) buf += chunk;

const got = new Map();
for (const line of buf.split("\n")) {
  if (line.trim() === "") continue;
  const m = JSON.parse(line);
  const r = m.result ?? {};
  got.set(m.id, r.content ? r.content[0].text : JSON.stringify(r));
}

const est = (b) => Math.round(b / BYTES_PER_TOKEN);
let failed = 0;
let fixed = 0;
let perQuery = 0;

console.log("");
console.log("  what                        bytes   ~tok   budget");
console.log("  " + "-".repeat(56));
for (const r of SESSION) {
  const payload = got.get(r.id);
  if (payload === undefined) {
    console.log(`  MISSING ${r.label}`);
    failed++;
    continue;
  }
  const b = Buffer.byteLength(payload);
  const over = b > BUDGET[r.id];
  if (over) failed++;
  if (r.kind === "fixed") fixed += b;
  if (r.kind === "query") perQuery = Math.max(perQuery, b);
  console.log(
    `  ${r.label.padEnd(26)} ${String(b).padStart(5)}  ${String(est(b)).padStart(5)}   ${String(BUDGET[r.id]).padStart(5)}${over ? "  OVER" : ""}`
  );
  if (show) console.log("\n" + payload.split("\n").map((l) => "      " + l).join("\n") + "\n");
}

console.log("");
console.log(`  fixed, once per session     ${fixed} bytes  (~${est(fixed)} tokens)`);
console.log(`  worst single query          ${perQuery} bytes  (~${est(perQuery)} tokens)`);
console.log(`  a 20-question session       ${fixed + 20 * perQuery} bytes  (~${est(fixed + 20 * perQuery)} tokens)`);
console.log("");

if (failed > 0) {
  console.log(`  ${failed} payload(s) over budget. Either make it cheaper or move the budget on purpose.`);
  process.exit(1);
}
console.log("  every payload within budget");

// The one thing about a context service you cannot show in a JSON payload: what it
// refuses to say.
//
//   npm run ask                       the four beats, in order
//   npm run ask -- "gas can"          one question against the live snapshot
//
// The feed and this share a snapshot. The difference is who is asking. A person reads
// "unverified, last checked four hours ago" in the margin and discounts the row. A model
// handed the same row flattens it into a sentence and the margin is the first thing to
// go. So the guarantee lives in the shape of the reply instead of in a field beside it.
//
// The beat worth watching is the third and fourth together. The same broken source is
// still allowed to report a recall it saw, and is not allowed to report that it found
// nothing. A notice does not expire, so presence survives staleness. Absence does not,
// because the ordinary way to fail a contract is to come back with fewer rows than you
// started with, and silence from a source that just lost a third of its records is not
// evidence of anything.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { recallContext, vouchReport } from "./context.js";
import type { Snapshot } from "./snapshot.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const SNAP = JSON.parse(
  readFileSync(join(ROOT, "web", "public", "snapshot.json"), "utf8")
) as Snapshot;

const BOLD = "[1m";
const DIM = "[2m";
const OFF = "[0m";
const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";

const plain = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const c = (code: string, s: string): string => (plain ? s : `${code}${s}${OFF}`);
const rule = (): void => console.log(c(DIM, "-".repeat(78)));

/** The same feed after a cycle that failed its contract on a row-count cliff. Built by
 *  hand rather than by breaking anything, and labelled SIMULATED wherever it prints: a
 *  demo that could be mistaken for a live incident is the kind of thing this project
 *  exists to complain about. The numbers are the shape `runs/timing.log` records. */
function afterTheSourceBreaks(snap: Snapshot): Snapshot {
  const breach = "row count fell 31.0% against a baseline of 29, limit 20.0%";
  return {
    ...snap,
    sources: snap.sources.map((s) =>
      s.id === "cpsc"
        ? { ...s, trust: "unverified" as const, contractPassed: false, rows: 20, breaches: [breach] }
        : s
    ),
    recalls: snap.recalls.map((r) =>
      r.provenance.sourceId === "cpsc"
        ? { ...r, provenance: { ...r.provenance, trust: "unverified" as const } }
        : r
    ),
  };
}

function ask(snap: Snapshot, query: string, label: string, note: string): void {
  console.log("");
  console.log(`  ${c(BOLD, label)}`);
  console.log(c(DIM, `  ${note}`));
  console.log("");
  console.log(`  ${c(DIM, "ask")}  ${JSON.stringify(query)}`);

  const a = recallContext(snap, query);

  if (a.refusal !== null) {
    console.log(`  ${c(RED, "REFUSED")}`);
    for (const line of wrap(a.refusal)) console.log(c(RED, `          ${line}`));
    console.log("");
    return;
  }

  if (a.asserted.length === 0) {
    console.log(`  ${c(GREEN, "ANSWER")}   no recall matched, and this feed can currently say so`);
    console.log("");
    return;
  }

  for (const hit of a.asserted) {
    console.log(`  ${c(GREEN, "ANSWER")}   ${c(BOLD, hit.ref)}  ${hit.title.slice(0, 52)}`);
    console.log(
      c(DIM, `           ${hit.basis} at ${hit.confidence.toFixed(2)} on [${hit.matchedTokens.join(", ")}]`)
    );
    console.log(
      c(DIM, `           ${hit.vouch.sourceLabel}, ${hit.vouch.state}, last confirmed ${hit.vouch.lastVerifiedAt ?? "never"}`)
    );
  }
  if (a.caution !== null) {
    console.log("");
    for (const line of wrap(a.caution)) console.log(c(YELLOW, `  CAUTION  ${line}`));
  }
  if (a.withheld.length > 0) {
    console.log("");
    for (const w of a.withheld) console.log(c(DIM, `  withheld ${w.count} x ${w.reason}`));
  }
  console.log("");
}

function wrap(s: string, width = 66): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    if ((line + word).length > width) {
      out.push(line.trimEnd());
      line = "";
    }
    line += word + " ";
  }
  if (line.trim() !== "") out.push(line.trimEnd());
  return out;
}

// --- run ---------------------------------------------------------------------

const arg = process.argv.slice(2).join(" ").trim();
const healthy = SNAP;
const broken = afterTheSourceBreaks(SNAP);

if (arg !== "") {
  ask(healthy, arg, "ONE QUESTION", "against the published snapshot, as it stands now");
  process.exit(0);
}

const RECALLED = SNAP.recalls[0]?.title.split(" ").slice(0, 4).join(" ") ?? "pressure washer";
const NOT_RECALLED = "wireless bluetooth headphones";

console.log("");
rule();
console.log(`  ${c(BOLD, "VOUCH AS A CONTEXT SERVICE")}`);
console.log(c(DIM, "  The same snapshot the site renders, answered for something that will act"));
console.log(c(DIM, "  on the answer. Presence survives staleness. Absence does not."));
rule();

console.log("");
console.log(`  ${c(BOLD, "1. EVERY SOURCE VERIFIED")}`);
console.log(
  c(DIM, `  canReportAbsence = ${String(vouchReport(healthy).canReportAbsence)}`)
);

ask(healthy, RECALLED, "1a. a recalled product", "the ordinary case: assert it, and show the work");
ask(healthy, NOT_RECALLED, "1b. a product with no recall", "absence is a claim, and right now we can make it");

rule();
console.log("");
console.log(`  ${c(BOLD, "2. THE RECALL SOURCE FAILS ITS CONTRACT")}   ${c(YELLOW, "SIMULATED")}`);
console.log(c(DIM, "  row count fell 31.0% against a baseline of 29, limit 20.0%"));
console.log(
  c(DIM, `  canReportAbsence = ${String(vouchReport(broken).canReportAbsence)}`)
);

ask(broken, RECALLED, "2a. the same recalled product", "a notice does not expire, so the hit still stands");
ask(broken, NOT_RECALLED, "2b. the same product with no recall", "this is the one that has to stop");

rule();
console.log("");
console.log(c(DIM, "  Same data, same query, opposite answers, and the difference is not"));
console.log(c(DIM, "  confidence. It is which claim the evidence supports."));
console.log("");

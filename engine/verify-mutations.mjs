// Do the engine's tests actually hold the safety invariants up?
//
// A test suite that passes proves the code does what the tests describe. It does not
// prove the tests describe anything that matters. The way to tell is to break each
// invariant on purpose and check the suite notices, so every mutation below removes a
// guarantee this project states in public, and the suite is required to go red.
//
// Four of these were real bugs, not hypotheticals. The prior-cycle phantom and the
// raw-HTML gone match both shipped, and both were found by other people reading this
// code. They are here so they cannot come back quietly.
//
// The same rule as the web harness, learned the same painful way: an unapplied mutation
// always passes, and looks exactly like a hole that isn't there. So each mutation
// asserts its target exists before editing and asserts the file changed after, and the
// suite refuses to conclude anything from an edit it cannot prove it made.
//
//   node verify-mutations.mjs        # all of them
//   node verify-mutations.mjs 1 4    # just those
//
// Run from engine/, on a clean tree. Reverts each mutation before the next.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTATIONS = [
  {
    name: "a withdrawn record becomes repairable",
    breaks: "the core rule: healing a record that was taken down republishes a phantom recall",
    file: "src/classify.ts",
    from: 'return { cause: "gone", withdrawnRefs, lostRefs: [], unresolvedRefs: [], healable: false, evidence };',
    to: 'return { cause: "drift", withdrawnRefs, lostRefs: [], unresolvedRefs: [], healable: true, evidence };',
  },
  {
    name: "the phantom guard forgets earlier cycles",
    breaks: "a record proved gone last cycle can be re-fabricated by an unrelated repair and served as healed",
    file: "src/runner.ts",
    from: "const phantoms = afterRefs.filter((r) => knownWithdrawn.includes(r));",
    to: "const phantoms = afterRefs.filter((r) => diagnosis.withdrawnRefs.includes(r));",
  },
  {
    name: "a repair may abandon the record it was called for",
    breaks: "a partial repair closes the incident as healed and the abandoned notice leaves the baseline",
    file: "src/runner.ts",
    from: 'const abandoned = diagnosis.lostRefs.filter((r) => !afterRefs.includes(r));',
    to: 'const abandoned = [];',
  },
  {
    name: "the abandonment refusal is downgraded to a warning",
    breaks: "the row-drop limit then ratchets: each accepted partial repair is the next one's baseline",
    file: "src/runner.ts",
    from: 'if (abandoned.length > 0) {',
    to: 'if (abandoned.length > 99) {',
  },
  {
    name: "the gone oracle reads script payloads",
    breaks: "a live listing whose page embeds the phrase in a UI string table is published as withdrawn",
    file: "src/oracles.ts",
    from: "const hay = saidOnPage(body);",
    to: "const hay = body.toLowerCase();",
  },
  {
    name: "the oracle stops normalising whitespace, so a learned phrase cannot match",
    breaks: "a marker learned from a page no longer fires on that page, and gone reads as repairable drift",
    file: "src/html.ts",
    from: "return normaliseSpacing(visibleText(html)).toLowerCase();",
    to: "return visibleText(html).toLowerCase();",
  },
  {
    name: "normalisation flattens newlines as well as spaces",
    breaks: "two elements that separately say ordinary words add up to a withdrawal phrase neither said",
    file: "src/html.ts",
    from: "return s.replace(/[^\\S\\n]+/g, \" \");",
    to: "return s.replace(/\\s+/g, \" \");",
  },
  {
    name: "the block oracle reads visible text only, like the gone oracle",
    breaks: "a wall that renders its message from script is served as an ordinary page and authorises a repair",
    file: "src/oracles.ts",
    from: "if (raw.includes(m) || said.includes(m)) return m;",
    to: "if (said.includes(m)) return m;",
  },
  {
    name: "a stale source is allowed to report that it found nothing",
    breaks: "an agent tells someone a product is not recalled on the word of a source that just lost rows",
    file: "src/context.ts",
    from: "  if (broken.length > 0) {",
    to: "  if (false) {",
  },
  {
    name: "an open block stops counting against a source",
    breaks: "a source we were refused by keeps licensing \"no recall matched\", because the rows it is still serving are the last good ones",
    file: "src/context.ts",
    from: '    const open = openBreakage(snapshot, id);',
    to: '    const open = null;',
  },
  {
    name: "a withdrawal counts as breakage",
    breaks: "the service refuses to answer every time a notice is withdrawn, which is an ordinary event and not a failure",
    file: "src/context.ts",
    from: 'const BREAKAGE: readonly IncidentCause[] = ["drift", "pagination", "blocked"];',
    to: 'const BREAKAGE: readonly IncidentCause[] = ["drift", "pagination", "blocked", "gone"];',
  },
  {
    name: "the page oracle stops decoding numeric entities",
    breaks: "a withdrawal written with &#160; instead of &nbsp; reads as merely missing, and missing is what authorises a repair",
    file: "src/html.ts",
    from: '    .replace(/&#(\\d+);/g, (m, d: string) => codePoint(Number(d), m))',
    to: '',
  },
  {
    name: "the vouch check walks the snapshot instead of the declared source list",
    breaks: "a recall source missing from the build stops being checked exactly when it matters",
    file: "src/context.ts",
    from: "  for (const id of RECALL_SOURCES) {",
    to: "  for (const id of snapshot.sources.map((x) => x.id)) {",
  },
  {
    name: "a stale hit is withheld along with everything else stale",
    breaks: "a real recall is hidden from the person about to buy the product, to keep a rule tidy",
    file: "src/context.ts",
    from: "  if (asserted.length > 0) {",
    to: "  if (asserted.length > 0 && broken.length === 0) {",
  },
  {
    name: "the refusal is printed under the answer instead of leading it",
    breaks: "the one line that stops a caller inventing an answer sits below everything it could quote",
    file: "src/wire.ts",
    from: "    out.push(`REFUSED ${a.refusalCode}`);\n    if (a.refusal !== null) out.push(a.refusal);",
    to: "    if (a.refusal !== null) out.push(a.refusal);\n    out.push(`REFUSED ${a.refusalCode}`);",
  },
  {
    name: "a withdrawal is reported as something to retry",
    breaks: "an agent waits and calls again for records the publisher deliberately took down",
    file: "src/context.ts",
    from: '  if (cause === "gone") {',
    to: "  if (false) {",
  },
  {
    name: "compaction drops the synthetic-fixture label",
    breaks: "a fixture built to induce failures is served to an agent as a real recall notice",
    file: "src/wire.ts",
    from: "    if (r.vouch.synthetic) bits.push(\"SYNTHETIC FIXTURE\");",
    to: "    if (false) bits.push(\"SYNTHETIC FIXTURE\");",
  },
  {
    name: "a refusal is emitted without a code to branch on",
    breaks: "a caller has to match the refusal by substring, which breaks the first time the wording improves",
    file: "src/context.ts",
    from: '      refusalCode: "absence_unverifiable",',
    to: "      refusalCode: null,",
  },
  {
    name: "a published link may downgrade to http on the same host",
    breaks: "a reader is handed an unencrypted link under a label saying we verified where it goes",
    file: "src/trust.ts",
    from: 'if (source.protocol === "https:" && link.protocol === "http:") return null;',
    to: "if (false) return null;",
  },
  {
    name: "the fallback serves records known to be withdrawn",
    breaks: "a refused cycle republishes a record we already proved was taken down, labelled unverified",
    file: "src/runner.ts",
    from: "(r) => !knownWithdrawn.includes(args.refOf(r))",
    to: "() => true",
  },
  {
    name: "unresolved permalinks count as still published",
    breaks: "the allowlist that keeps a blocked or unreachable probe from authorising a repair",
    file: "src/classify.ts",
    from: "return !(p.status === 200 && (p.goneSignature ?? null) === null);",
    to: "return p.status === 404 || p.status === 410;",
  },
  {
    name: "the proxy's own failure counts as the site's answer",
    breaks: "a Bright Data navigation timeout becomes evidence about whether a record exists",
    file: "src/bdata.ts",
    from: "if (brdError(env.headers) !== null) return null;",
    to: "if (false) return null;",
  },
  {
    name: "the evolver may learn into the seller field",
    breaks: "the one guarantee this project makes about people rather than data",
    file: "src/evolve.ts",
    from: 'const NEVER_LEARN_INTO = new Set(["seller"]);',
    to: "const NEVER_LEARN_INTO = new Set([]);",
  },
  {
    name: "a learned withdrawal phrase applies itself",
    breaks: "the rule that a change which can remove live recalls from the feed waits for a person",
    file: "src/learn/policy.ts",
    from: `      return {
        unattended: false,
        because: "a wrong withdrawal phrase removes live recalls from the feed, so a person reads the evidence",
      };`,
    to: `      return {
        unattended: true,
        because: "a wrong withdrawal phrase removes live recalls from the feed, so a person reads the evidence",
      };`,
  },
  {
    name: "records are labelled verified regardless of trust",
    breaks: "the feed's health strip and its records can disagree during a degraded cycle",
    file: "src/trust.ts",
    from: 'if (!(report.passed || explainedByWithdrawal)) return "unverified";',
    to: 'if (false) return "unverified";',
  },
  {
    name: "a scraped permalink is published unchecked",
    breaks: "a lookalike host is rendered as a trusted link under a verified pill",
    file: "src/trust.ts",
    from: "if (link.host !== source.host) return null;",
    to: "if (false) return null;",
  },
  {
    name: "a disproved withdrawal phrase is kept",
    breaks: "the supervisor's only unattended change to its own oracle, which is the safe direction",
    file: "src/learn/markers.ts",
    from: "      out.push({ marker: l.marker, source: l.source, disprovedBy: live[0] ?? \"unknown\" });",
    to: "      void live;",
  },
  {
    name: "a retracted phrase stays active",
    breaks: "a retraction can be undone by an edit that forgets to remove the learned entry too",
    file: "src/learn/markers.ts",
    from: "    .filter((l) => l.source === source && !dead.has(l.marker))",
    to: "    .filter((l) => l.source === source)",
  },
  {
    name: "a withdrawal phrase learned on one site applies everywhere",
    breaks: "the scoping that keeps eBay's 404 chrome from marking a regulator's live recall withdrawn",
    file: "src/learn/markers.ts",
    from: "    .filter((l) => l.source === source && !dead.has(l.marker))",
    to: "    .filter((l) => !dead.has(l.marker))",
  },
  {
    name: "a blocked source is hammered instead of left alone",
    breaks: "backoff: the cycle keeps paying for a request the source has already refused",
    file: "src/runner.ts",
    from: "  const waiting = coolingDown(state.cooldownUntil, deps.now());",
    to: "  const waiting = null as number | null;",
  },
  {
    name: "a withdrawal puts the feed into backoff",
    breaks: "the rule that a source working correctly is never throttled for it",
    file: "src/backoff.ts",
    from: 'if (cause === "healthy" || cause === "resurrected" || cause === "gone") return null;',
    to: 'if (cause === "healthy" || cause === "resurrected") return null;',
  },
  {
    name: "a repair that keeps failing is retried forever",
    breaks: "the repair budget, so the same prompt goes to the same collector at cost with no new information",
    file: "src/runner.ts",
    from: "  if (repairExhausted(state.streak, diagnosis.cause) && streak !== null) {",
    to: "  if (false && streak !== null) {",
  },
  {
    name: "a repair that never ran is charged to the budget",
    breaks: "the distinction between a repair that failed and one that was never attempted",
    file: "src/runner.ts",
    from: "      nextState: carried({ streak: state.streak }),\n    };\n  }\n\n  // A call that never reached the collector",
    to: "      nextState: carried(),\n    };\n  }\n\n  // A call that never reached the collector",
  },
  {
    name: "one withdrawal excuses a drop of any size",
    breaks: "the check that withdrawals actually account for missing rows, so silent extraction loss reads as verified",
    file: "src/trust.ts",
    from: "    volumeOnly && shortfall > 0 && shortfall <= (state?.withdrawnRefs.length ?? 0);",
    to: "    volumeOnly && (state?.withdrawnRefs.length ?? 0) > 0;",
  },
  {
    name: "the collector-block pattern forgets half the refusal statuses",
    breaks: "the consistency between what the probe calls a refusal and what the collector's error may say",
    file: "src/classify.ts",
    from: 'const BLOCK_STATUS_PATTERN = new RegExp(`(?<![0-9])(${[...BLOCK_STATUSES].join("|")})(?![0-9])`);',
    to: 'const BLOCK_STATUS_PATTERN = /(?<![0-9])(403|407|429)(?![0-9])/;',
  },
  {
    name: "a block discards a withdrawal already established",
    breaks: "a 404 the oracle saw plainly is thrown away, so a withdrawn recall keeps being served as active",
    file: "src/classify.ts",
    from: "      cause: \"blocked\",\n      withdrawnRefs,",
    to: "      cause: \"blocked\",\n      withdrawnRefs: [],",
  },
  {
    name: "the marker store trusts whatever parsed",
    breaks: "an empty-string marker reads every page as withdrawn, and a wrong-shape file crashes the cycle",
    file: "src/learn/markers.ts",
    from: "    return sanitiseMarkerStore(JSON.parse(readFileSync(path, \"utf8\")));",
    to: "    return JSON.parse(readFileSync(path, \"utf8\")) as MarkerStore;",
  },
  {
    name: "a phrase too short to mean anything is accepted",
    breaks: "the floor under a learned marker, below which one phrase empties the feed",
    file: "src/learn/markers.ts",
    from: "  if (!usableMarker(m.marker)) return store;",
    to: "  if (false) return store;",
  },
  {
    name: "a learned alias is written where nothing reads it",
    breaks: "the only unattended change in the system, which would report an adaptation it did not make",
    file: "src/aliases.ts",
    from: 'export const ALIAS_DRIVEN_SOURCES: ReadonlySet<string> = new Set(["tradewell"]);',
    to: 'export const ALIAS_DRIVEN_SOURCES: ReadonlySet<string> = new Set(["tradewell", "arcadia", "ebay"]);',
  },
  {
    name: "a block only the collector saw is healed",
    breaks: "the flagship refusal, whenever the wall is on the scraper's path and not the operator's",
    file: "src/classify.ts",
    from: "const sourceSideBlock = blockedAtSource(input.extractionErrors ?? []);",
    to: "const sourceSideBlock = null;",
  },
];

/** How many tests fail, or null if the suite passed. The count is the useful part: a
 *  mutation caught by one test is held up by one test. */
function failuresUnderTest() {
  try {
    execFileSync("npm", ["test"], { stdio: "pipe", encoding: "utf8" });
    return null;
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const m = /^# fail (\d+)$/m.exec(out) ?? /fail (\d+)/.exec(out);
    return m === null ? 0 : Number(m[1]);
  }
}

const argv = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const chosen = argv.length > 0 ? argv : MUTATIONS.map((_, i) => i + 1);

// A `finally` does not run when the process is killed, and this harness spends most of
// its wall time with a safety invariant deleted from a tracked file. A Ctrl+C at the
// wrong moment left `NEVER_LEARN_INTO` emptied in the working tree: the lock that keeps
// the learner away from seller fields, removed, silently, in a file that still looked
// like the committed one at a glance. Whatever happens to this process, the tree it was
// handed goes back.
let inFlight = null;
function restoreInFlight() {
  if (inFlight === null) return;
  writeFileSync(inFlight.file, inFlight.before);
  inFlight = null;
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restoreInFlight();
    console.error(`\n${sig}: restored ${"the mutated file"} before exiting.`);
    process.exit(130);
  });
}
process.on("uncaughtException", (err) => {
  restoreInFlight();
  throw err;
});

const results = [];
for (const n of chosen) {
  const m = MUTATIONS[n - 1];
  if (m === undefined) {
    console.error(`no mutation ${n}. There are ${MUTATIONS.length}.`);
    process.exit(2);
  }

  const before = readFileSync(m.file, "utf8");

  // A mutation is only evidence if it edits what it names. This guard exists because one
  // did not: escaping collapsed a `from` string to "0", which occurs all over the file, so
  // `includes` passed, the replace landed inside an unrelated comment, the suite stayed
  // green, and the harness reported a hole in the tests that was not there. A target has to
  // be long enough to be deliberate and to appear exactly once.
  const occurrences = before.split(m.from).length - 1;
  if (m.from.length < 20 || occurrences > 1) {
    console.error(`\nmutation ${n} (${m.name})`);
    console.error(
      m.from.length < 20
        ? `  TARGET TOO SHORT: ${JSON.stringify(m.from)} is not a deliberate anchor.`
        : `  TARGET NOT UNIQUE: appears ${occurrences} times in ${m.file}.`
    );
    console.error("  A mutation that edits the wrong place proves nothing either way.");
    process.exit(2);
  }

  if (!before.includes(m.from)) {
    console.error(`\nmutation ${n} (${m.name})`);
    console.error(`  STALE: ${m.file} no longer contains the target text.`);
    console.error(`  looked for: ${JSON.stringify(m.from.slice(0, 90))}`);
    console.error(`  Fix the mutation, do not skip it: an unapplied mutation always passes.`);
    process.exit(2);
  }

  const after = before.replace(m.from, m.to);
  if (after === before) {
    console.error(`\nmutation ${n}: replace was a no-op. Refusing to draw a conclusion.`);
    process.exit(2);
  }

  inFlight = { file: m.file, before };
  writeFileSync(m.file, after);
  let failures;
  try {
    failures = failuresUnderTest();
  } finally {
    restoreInFlight();
  }

  const caught = failures !== null && failures > 0;
  results.push({ n, m, failures, caught });
  console.log(
    `${caught ? "caught " : "ESCAPED"}  ${n}. ${m.name}` +
      (caught ? `  (${failures} test${failures === 1 ? "" : "s"} fail)` : "")
  );
}

const escaped = results.filter((r) => !r.caught);
console.log("");
for (const r of escaped) {
  console.log(`ESCAPED  ${r.n}. ${r.m.name}`);
  console.log(`         breaks: ${r.m.breaks}`);
  console.log(`         the suite did not notice. That is a hole, not a pass.`);
}
console.log(`${results.length - escaped.length}/${results.length} mutations caught`);
process.exit(escaped.length === 0 ? 0 : 1);

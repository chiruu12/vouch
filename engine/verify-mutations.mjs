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
    name: "the gone oracle reads script payloads",
    breaks: "a live listing whose page embeds the phrase in a UI string table is published as withdrawn",
    file: "src/bdata.ts",
    from: "const hay = visibleText(body).toLowerCase();",
    to: "const hay = body.toLowerCase();",
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
    from: "return link.host === new URL(sourceUrl).host ? permalink : null;",
    to: "return permalink;",
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

  writeFileSync(m.file, after);
  let failures;
  try {
    failures = failuresUnderTest();
  } finally {
    writeFileSync(m.file, before);
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

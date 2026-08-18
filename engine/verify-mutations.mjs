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

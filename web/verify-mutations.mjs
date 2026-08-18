// Does verify-output.mjs actually catch what it claims to catch?
//
// verify-output.mjs enforces the feed's central promise: that text the engine wrote
// reaches the page whole. A check nobody has attacked is a check nobody has tested, and
// this one has been wrong four times. Each version passed a mutation it claimed to
// catch, so each rule in it now has a mutation here that fails without it.
//
// Every mutation below breaks a real guarantee in a way a careless edit plausibly
// could. The suite applies one, rebuilds, runs the verifier, and requires it to exit
// non-zero. A mutation the verifier survives is a hole, and the suite says so.
//
// One rule about the harness itself, learned the hard way: an earlier version of this
// ran the mutations through a shell one-liner, the quoting ate one of the expressions,
// the file was never modified, the build came out clean, and the run reported ESCAPED.
// A no-op mutation looks exactly like a hole. So every mutation asserts its target
// exists before editing and asserts the file changed after, and the suite refuses to
// draw any conclusion from an edit it cannot prove it made.
//
//   node verify-mutations.mjs          # all of them, ~30s each
//   node verify-mutations.mjs 3 7      # just those
//
// Run from web/, on a clean tree. Reverts each mutation before the next.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** Each mutation names the guarantee it breaks, so a failure says what was lost
 *  rather than which line moved. */
const MUTATIONS = [
  {
    name: "head-truncate a refusal on the front page only",
    breaks: "a refusal is quoted whole on every page that carries it",
    file: "app/page.tsx",
    from: '{i.refusal ?? ""}',
    to: '{(i.refusal ?? "").slice(38)}',
  },
  {
    name: "tail-truncate a refusal on the front page only",
    breaks: "same, from the other end",
    file: "app/page.tsx",
    from: '{i.refusal ?? ""}',
    to: '{(i.refusal ?? "").slice(0, -40)}',
  },
  {
    name: "delete the visible breaches, leaving them in the RSC payload",
    breaks: "rendered, not merely present in the file",
    file: "app/incidents/page.tsx",
    from: "<Evidence lines={i.breaches} />",
    to: "<span />",
  },
  {
    name: "delete the whole front-page refusal section",
    breaks: "the front page declines on the front page",
    file: "app/page.tsx",
    from: "{refusals.length === 0 ? null : (",
    to: "{true ? null : (",
  },
  {
    name: "hide a refusal behind a disclosure",
    breaks: "nothing is folded away",
    file: "components/parts.tsx",
    from: "{children}\n      </p>",
    to: "<details><summary>show</summary>{children}</details>\n      </p>",
  },
  {
    name: "leak a seller key into a listing row",
    breaks: "no seller identity reaches the page",
    file: "components/parts.tsx",
    from: '<div className="listing" data-withdrawn={withdrawn}>',
    to: '<div className="listing" data-withdrawn={withdrawn} data-x="sk_deadbeef">',
  },
  {
    name: "truncate every evidence line",
    breaks: "the classifier's own sentences are unedited",
    file: "components/parts.tsx",
    from: "<li key={i}>{line}</li>",
    to: "<li key={i}>{line.slice(0, -12)}</li>",
  },
  {
    name: "drop the deferral's refusal from the log",
    breaks: "a deferral is recorded, not quietly folded into the refusals",
    file: "app/incidents/page.tsx",
    from: "{refused ? (",
    to: "{refused && !i.healDeferred ? (",
  },
  {
    name: "truncate one of two renderings of the same sentence",
    breaks: "each rendering stands on its own, not on a twin elsewhere on the page",
    file: "app/method/page.tsx",
    from: '<p className="clash">clash: {e.contradiction}</p>',
    to: '<p className="clash">clash: {e.contradiction.slice(0, -10)}</p>',
  },
  {
    name: "head-truncate one of two renderings of the same sentence",
    breaks: "same, where the surviving copy would otherwise answer for the cut one",
    file: "app/method/page.tsx",
    from: '<p className="clash">clash: {e.contradiction}</p>',
    to: '<p className="clash">clash: {e.contradiction.slice(12)}</p>',
  },
];

const wanted = process.argv.slice(2).map(Number);
const chosen = wanted.length === 0 ? MUTATIONS.map((_, i) => i + 1) : wanted;

function build() {
  execFileSync("npx", ["next", "build"], { stdio: "ignore" });
}

/** Non-zero exit means the verifier objected, which is what we want here. */
function verifierRejects() {
  try {
    execFileSync("node", ["verify-output.mjs"], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
}

const results = [];
for (const n of chosen) {
  const m = MUTATIONS[n - 1];
  if (m === undefined) {
    console.error(`no mutation ${n}. There are ${MUTATIONS.length}.`);
    process.exit(2);
  }

  const before = readFileSync(m.file, "utf8");
  if (!before.includes(m.from)) {
    // The target moved. Not a pass and not a failure: the suite cannot say anything,
    // and saying nothing loudly is the only safe outcome.
    console.error(`\nmutation ${n} (${m.name})`);
    console.error(`  STALE: ${m.file} no longer contains the target text.`);
    console.error(`  looked for: ${JSON.stringify(m.from)}`);
    console.error(`  Fix the mutation, do not skip it: an unapplied mutation always passes.`);
    process.exit(2);
  }

  const after = before.replace(m.from, m.to);
  if (after === before) {
    console.error(`\nmutation ${n}: replace was a no-op. Refusing to draw a conclusion.`);
    process.exit(2);
  }

  writeFileSync(m.file, after);
  let caught;
  try {
    build();
    caught = verifierRejects();
  } finally {
    writeFileSync(m.file, before);
  }

  results.push({ n, m, caught });
  console.log(`${caught ? "caught " : "ESCAPED"}  ${n}. ${m.name}`);
  if (!caught) console.log(`         breaks: ${m.breaks}`);
}

// Leave the tree with a build that matches the source, so a green run here cannot be
// mistaken for a green build of the mutated output.
build();

const escaped = results.filter((r) => !r.caught);
console.log(`\n${results.length - escaped.length}/${results.length} mutations caught`);
if (escaped.length > 0) {
  console.error(`\n${escaped.length} mutation(s) survived verify-output.mjs:`);
  for (const r of escaped) console.error(`  ${r.n}. ${r.m.name}\n     breaks: ${r.m.breaks}`);
  process.exit(1);
}

// The agents page shows a source failing its contract, and that failure is simulated.
//
// A simulation is allowed. What it is not allowed to do is describe something the engine
// could never produce, in a repo whose docs say every number came from a real run. Both
// this file's subject and its existence come from an outside review that checked the
// published breach sentence against the incident log, found nothing matching, and could
// not tell which of the two was lying.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkContract, volumeBreach, type SourceContract } from "./contract.js";
import { cliffFor, simulateFailingSource } from "./agentview.js";
import type { Snapshot } from "./snapshot.js";

/** A snapshot carrying only what these tests read. */
function snap(rows: number): Snapshot {
  return {
    sources: [{ id: "cpsc", rows, trust: "verified", contractPassed: true, breaches: [] }],
    recalls: [],
  } as unknown as Snapshot;
}

test("the simulated breach is a sentence the contract checker actually emits", () => {
  // The guard that matters. The two used to be written out separately and drifted into
  // different grammars: the checker says "fell from 14 to 11, a 21.4% drop", the page
  // said "fell 31.0% against a baseline of 29". Deriving both from `volumeBreach` is
  // what makes them incapable of disagreeing, so this asserts the derivation, not the
  // string.
  const contract: SourceContract = {
    version: "cpsc@1",
    sourceId: "cpsc",
    minRows: 1,
    maxRowDropRate: 0.2,
    fields: {},
  };
  const report = checkContract(contract, [] as never, 6, () => new Date("2026-08-20T00:00:00.000Z"));
  const fromChecker = report.breaches.find((b) => b.startsWith("row count fell"));

  assert.ok(fromChecker, "the checker must still produce a volume breach to compare against");
  assert.equal(fromChecker, volumeBreach(6, 0, 0.2), "the checker no longer routes through volumeBreach");
  assert.match(cliffFor(snap(6)).breach, /^row count fell from \d+ to \d+, a [\d.]+% drop, limit [\d.]+%$/);
});

test("the simulated cliff is derived from the rows the source really has", () => {
  // Hardcoding was the original defect: a baseline of 29 on a source carrying six rows.
  // A reader who checks the illustration against the feed has to find the same numbers.
  assert.equal(cliffFor(snap(6)).before, 6);
  assert.equal(cliffFor(snap(12)).before, 12);
  assert.equal(cliffFor(snap(6)).breach, volumeBreach(6, 4, 0.2));
});

test("the simulated cliff actually breaches the limit it quotes", () => {
  // An illustration of a failure that would not fail is worse than no illustration.
  for (const rows of [6, 9, 12, 29, 193]) {
    const { before, after } = cliffFor(snap(rows));
    const drop = (before - after) / before;
    assert.ok(drop > 0.2, `a drop of ${drop} from ${rows} rows does not breach the 20% limit`);
  }
});

test("the failing world marks the source unverified and lowers its row count", () => {
  const failing = simulateFailingSource(snap(6));
  const cpsc = failing.sources.find((s) => s.id === "cpsc");

  assert.equal(cpsc?.trust, "unverified");
  assert.equal(cpsc?.contractPassed, false);
  assert.equal(cpsc?.rows, 4, "the row count has to agree with the breach sentence beside it");
  assert.deepEqual(cpsc?.breaches, [cliffFor(snap(6)).breach]);
});

// One supervision cycle, end to end, with every outside call injected.
//
// classify.ts is tested on its verdicts and prompt.ts on its refusals, but the thing
// that decides what a reader actually sees is this file: the ordering of the probes,
// and which of the four causes results in a heal call being made at all. Those are
// separate guarantees from "the classifier said gone", and until now nothing checked
// them.
//
// The assertion that matters most in here is negative. For `blocked` and `gone`,
// `deps.heal` must never be called. Not "called and ignored": never called.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, runCycle, type CycleArgs, type CycleDeps, type Row, type SourceState } from "./runner.js";
import type { SourceContract } from "./contract.js";

const CONTRACT: SourceContract = {
  version: "test@1",
  sourceId: "tradewell",
  minRows: 3,
  maxRowDropRate: 0.2,
  fields: {
    id: { type: "string", maxNullRate: 0, minLength: 2 },
    title: { type: "string", maxNullRate: 0, minLength: 3 },
  },
};

const row = (id: string): Row => ({ id, title: `item ${id}` });
// Six rows with two-character ids. Both details are load-bearing: a one-character id
// breaches the contract's own minLength, and with five rows a single loss is exactly
// the 20% drop limit, so the fixture would sit on the threshold rather than under it.
const ROWS = ["r1", "r2", "r3", "r4", "r5", "r6"].map(row);

interface Calls {
  heal: number;
  runs: number;
}

/** Deps that record what was called, so a test can assert on an absence. */
function deps(over: Partial<CycleDeps> = {}): { deps: CycleDeps; calls: Calls } {
  const calls: Calls = { heal: 0, runs: 0 };
  const base: CycleDeps = {
    probeListing: async () => ({ status: 200, bodyBytes: 5000, blockSignature: null, body: "<html></html>" }),
    runScraper: async () => {
      calls.runs++;
      return { rows: ROWS, errors: [] };
    },
    probePermalinks: async (entries) => entries.map((e) => ({ ref: e.ref, status: 200 })),
    heal: async () => {
      calls.heal++;
      return { ok: true, durationMs: 1000, status: "done" };
    },
    observeMarkup: () => ({
      listingStatus: 200,
      listingBytes: 5000,
      deadSelectors: [".title"],
      observedHooks: ["data-testid"],
      observedLabels: ["Brand"],
    }),
    now: () => new Date("2026-08-18T10:00:00.000Z"),
  };
  return { deps: { ...base, ...over }, calls };
}

function args(state: SourceState, over: Partial<CycleArgs> = {}): CycleArgs {
  return {
    sourceId: "tradewell",
    collectorId: "c_test",
    url: "https://example.test/",
    contract: CONTRACT,
    state,
    permalinkFor: (ref) => `https://example.test/item/${ref}.html`,
    refOf: (r) => (typeof r.id === "string" ? r.id : ""),
    ...over,
  };
}

function seeded(rows: Row[]): SourceState {
  return {
    ...emptyState(),
    baselineRefs: rows.map((r) => String(r.id)),
    baselineRows: rows.length,
    lastVerifiedAt: "2026-08-17T10:00:00.000Z",
    lastGoodRows: rows,
  };
}

// --- the happy path ---------------------------------------------------------

test("a healthy run serves verified and opens no incident", async () => {
  const { deps: d, calls } = deps();
  const r = await runCycle(args(seeded(ROWS)), d);

  assert.equal(r.diagnosis.cause, "healthy");
  assert.equal(r.serving.state, "verified");
  assert.equal(r.serving.rows.length, 6);
  assert.equal(r.incident, null);
  assert.equal(calls.heal, 0);
  assert.equal(r.nextState.baselineRows, 6);
});

// --- the two refusals -------------------------------------------------------

test("a block never reaches the healer and never serves the empty result", async () => {
  const { deps: d, calls } = deps({
    probeListing: async () => ({
      status: 200, // the dangerous block: it does not announce itself with a 4xx
      bodyBytes: 900,
      blockSignature: "verify you are a human",
      body: "<html>verify you are a human</html>",
    }),
    runScraper: async () => ({ rows: [], errors: [{ error: "timeout" }] }),
  });
  const r = await runCycle(args(seeded(ROWS)), d);

  assert.equal(r.diagnosis.cause, "blocked");
  assert.equal(calls.heal, 0, "healing cannot clear a block and must not be attempted");
  assert.equal(r.serving.state, "unverified");
  assert.equal(r.serving.rows.length, 6, "should fall back to last-good, not serve nothing");
  assert.notEqual(r.incident?.refusal, null);
  // The baseline must survive a block, or the next healthy run reads as a recovery
  // from a cliff that never happened.
  assert.equal(r.nextState.baselineRows, 6);
});

test("a withdrawal is never repaired and the surviving rows are still served", async () => {
  const survivors = ROWS.slice(0, 3);
  const { deps: d, calls } = deps({
    runScraper: async () => ({ rows: survivors, errors: [] }),
    // The three missing records 404 at their own URLs: they were taken down.
    probePermalinks: async (entries) => entries.map((e) => ({ ref: e.ref, status: 404 })),
  });
  const r = await runCycle(args(seeded(ROWS)), d);

  assert.equal(r.diagnosis.cause, "gone");
  assert.equal(calls.heal, 0, "repairing a withdrawal fabricates the withdrawn records");
  assert.equal(r.serving.state, "verified");
  assert.equal(r.serving.rows.length, 3);
  assert.deepEqual(r.nextState.withdrawnRefs.sort(), ["r4", "r5", "r6"]);
  assert.match(r.incident?.refusal ?? "", /fabricate/);
});

// --- repairs ----------------------------------------------------------------

test("drift is repaired, and the repair is measured before anything is served", async () => {
  let run = 0;
  const { deps: d, calls } = deps({
    runScraper: async () => {
      run++;
      calls.runs++;
      // Broken first, fixed after the heal.
      return run === 1 ? { rows: [], errors: [] } : { rows: ROWS, errors: [] };
    },
  });
  const r = await runCycle(args(seeded(ROWS)), d);

  assert.equal(calls.heal, 1);
  assert.equal(run, 2, "the heal must be followed by a fresh run, not trusted");
  assert.equal(r.serving.state, "healed");
  assert.equal(r.incident?.verified, true);
  assert.equal(r.nextState.healHistory.length, 1);
  assert.equal(r.nextState.healHistory[0]?.promoted, true);
});

test("a repair that reports success and fixes nothing is not served", async () => {
  const { deps: d } = deps({
    runScraper: async () => ({ rows: [], errors: [] }), // still broken after the heal
    heal: async () => ({ ok: true, durationMs: 1000, status: "done" }),
  });
  const r = await runCycle(args(seeded(ROWS)), d);

  assert.equal(r.serving.state, "unverified");
  assert.equal(r.serving.rows.length, 6, "last-good, not the empty repaired output");
  assert.equal(r.incident?.verified, false);
  assert.match(r.incident?.refusal ?? "", /still fails the contract/);
  // The failed attempt is recorded, but not promoted.
  assert.equal(r.nextState.healHistory.at(-1)?.promoted, false);
});

test("a repair that could not start is a deferral, not a failed repair", async () => {
  const { deps: d } = deps({
    runScraper: async () => ({ rows: [], errors: [] }),
    // Heal is exclusive per collector; a concurrent call is rejected outright.
    heal: async () => ({ ok: false, durationMs: 2000, status: "heal_busy" }),
  });
  const r = await runCycle(args(seeded(ROWS)), d);

  assert.equal(r.incident?.healAttempted, false, "nothing was attempted, so nothing was tried");
  assert.match(r.incident?.refusal ?? "", /already running/);
  assert.equal(r.serving.state, "unverified");
  assert.equal(r.nextState.healHistory.length, 0, "a heal that never ran is not history");
});

// --- ordering ---------------------------------------------------------------

test("the listing is probed before the collector runs", async () => {
  const order: string[] = [];
  const { deps: d } = deps({
    probeListing: async () => {
      order.push("probe");
      return { status: 200, bodyBytes: 100, blockSignature: null, body: "" };
    },
    runScraper: async () => {
      order.push("run");
      return { rows: ROWS, errors: [] };
    },
  });
  await runCycle(args(seeded(ROWS)), d);

  // If extraction came first, a block would present as an empty result and be
  // diagnosed as drift, which is the misdiagnosis that costs credits and deepens
  // the block.
  assert.deepEqual(order, ["probe", "run"]);
});

test("withdrawals are recorded even when the contract passes", async () => {
  // One record out of six is gone: a 16.7% drop, under the 20% limit. That trips no
  // threshold, and if it is not reconciled it stays in the feed as an active recall
  // for good.
  const survivors = ROWS.slice(0, 5);
  const { deps: d, calls } = deps({
    runScraper: async () => ({ rows: survivors, errors: [] }),
    probePermalinks: async (entries) => entries.map((e) => ({ ref: e.ref, status: 410 })),
  });
  const r = await runCycle(args(seeded(ROWS)), d);

  assert.equal(r.report.passed, true, "a single loss should not breach the contract");
  assert.deepEqual(r.nextState.withdrawnRefs, ["r6"]);
  assert.equal(calls.heal, 0);
});

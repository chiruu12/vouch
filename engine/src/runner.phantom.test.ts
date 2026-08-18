// A record withdrawn in a PRIOR cycle must never be republished by a later heal.
//
// runner.ts guards the heal output against `diagnosis.withdrawnRefs`, which names only
// the refs this cycle confirmed down. A record confirmed withdrawn in an earlier cycle
// lives in `state.withdrawnRefs` / `knownWithdrawn`, and that list is never compared
// against what the healer hands back. So a healer that reconstructs a stale copy of an
// already-withdrawn record sails past the phantom check, is served as `healed`, and
// lands back in lastGoodRows and the baseline while it is simultaneously still listed
// as withdrawn. That is the exact phantom-recall failure this project exists to stop,
// arrived at through the state carried between cycles rather than the classifier.

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
const ROWS = ["r1", "r2", "r3", "r4", "r5", "r6"].map(row);

const argsFor = (state: SourceState): CycleArgs => ({
  sourceId: "tradewell",
  collectorId: "c_test",
  url: "https://example.test/",
  contract: CONTRACT,
  state,
  permalinkFor: (ref) => `https://example.test/item/${ref}.html`,
  refOf: (r) => (typeof r.id === "string" ? r.id : ""),
});

// r6 was withdrawn the cycle before. The surviving five still pass the contract.
function stateAfterWithdrawal(): SourceState {
  const survivors = ROWS.slice(0, 5);
  return {
    ...emptyState(),
    baselineRefs: survivors.map((r) => String(r.id)),
    baselineRows: survivors.length,
    lastVerifiedAt: "2026-08-17T10:00:00.000Z",
    lastGoodRows: survivors,
    withdrawnRefs: ["r6"],
  };
}

test("a heal that resurrects a prior-cycle withdrawal is still caught, not served", async () => {
  let run = 0;
  const deps: CycleDeps = {
    probeListing: async () => ({ status: 200, bodyBytes: 5000, blockSignature: null, body: "<html></html>" }),
    runScraper: async () => {
      run++;
      // Pre-heal: the five survivors come back, but with a blank title, so the field
      // breaches and the cycle is diagnosed as repairable drift. No ref is missing, so
      // nothing is probed and nothing is withdrawn this cycle.
      if (run === 1) return { rows: ROWS.slice(0, 5).map((r) => ({ ...r, title: "" })), errors: [] };
      // Post-heal: the healer reconstructs the full catalogue, including the r6 that
      // was withdrawn in the previous cycle and is still in state.withdrawnRefs.
      return { rows: ROWS, errors: [] };
    },
    probePermalinks: async (entries) => entries.map((e) => ({ ref: e.ref, status: 200 })),
    heal: async () => ({ ok: true, durationMs: 1000, status: "done" }),
    observeMarkup: () => ({
      listingStatus: 200,
      listingBytes: 5000,
      deadSelectors: [".title"],
      observedHooks: [],
      observedLabels: [],
    }),
    now: () => new Date("2026-08-18T10:00:00.000Z"),
  };

  const r = await runCycle(argsFor(stateAfterWithdrawal()), deps);

  assert.equal(r.diagnosis.cause, "drift");
  assert.equal(r.diagnosis.withdrawnRefs.length, 0, "nothing withdrawn this cycle");

  const servedIds = r.serving.rows.map((x) => String(x.id));
  assert.equal(
    servedIds.includes("r6"),
    false,
    "r6 was proved withdrawn in a previous cycle; the heal must not republish it as healed output"
  );
  assert.equal(
    r.nextState.lastGoodRows.some((x) => String(x.id) === "r6"),
    false,
    "r6 must not re-enter lastGoodRows after being re-fabricated"
  );
  assert.equal(
    r.nextState.baselineRefs.includes("r6"),
    false,
    "r6 must not leak back into the baseline"
  );
  assert.ok(
    r.nextState.withdrawnRefs.includes("r6"),
    "r6 must stay marked withdrawn"
  );
});

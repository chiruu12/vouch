// A repair is not allowed to close an incident by agreeing with the loss.
//
// The classifier is careful about calling a record gone: a ref missing from the listing
// is only `withdrawn` once its own permalink stops resolving, and a ref that is missing
// while its page still returns 200 is `drift`, which is repairable. That care is what the
// four-cause taxonomy is for.
//
// The repair's acceptance test was weaker than the detection test that opened the
// incident. It checked two things: that the output contains no record already proved
// withdrawn, and that the output satisfies the contract. Neither of those looks at the
// records the incident was opened about. So a repair that comes back still missing a
// notice we proved is live satisfies both, because five of six rows is a 17% drop against
// a 20% limit. The incident closes as verified, an MTTR is recorded, the survivors are
// published as `healed`, and the missing recall notice leaves the baseline for good with
// nothing open to say it was dropped.
//
// The row-drop limit then makes it compounding rather than a one-off: each accepted
// partial repair becomes the baseline the next one is measured against, so a source can
// be walked down a legal step at a time while every cycle reports success.

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
const WITHOUT_R6 = ROWS.slice(0, 5);

const argsFor = (state: SourceState): CycleArgs => ({
  sourceId: "tradewell",
  collectorId: "c_test",
  url: "https://example.test/",
  contract: CONTRACT,
  state,
  permalinkFor: (ref) => `https://example.test/item/${ref}.html`,
  refOf: (r) => (typeof r.id === "string" ? r.id : ""),
});

/** Six notices, all vouched for last cycle. */
function healthyState(): SourceState {
  return {
    ...emptyState(),
    baselineRefs: ROWS.map((r) => String(r.id)),
    baselineRows: ROWS.length,
    lastVerifiedAt: "2026-08-17T10:00:00.000Z",
    lastGoodRows: ROWS,
  };
}

/** The collector drops r6 and the repair does not bring it back. r6's own page is fine
 *  throughout, which is what makes it a repairable loss rather than a withdrawal. */
function partialRepair(): { deps: CycleDeps; probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    deps: {
      probeListing: async () => ({ status: 200, bodyBytes: 5000, blockSignature: null, body: "<html></html>" }),
      runScraper: async () => ({ rows: WITHOUT_R6, errors: [] }),
      probePermalinks: async (entries) => {
        for (const e of entries) probed.push(e.ref);
        return entries.map((e) => ({ ref: e.ref, status: 200 }));
      },
      heal: async () => ({ ok: true, durationMs: 1000, status: "done" }),
      observeMarkup: () => ({
        listingStatus: 200,
        listingBytes: 5000,
        deadSelectors: [".notice"],
        observedHooks: [],
        observedLabels: [],
      }),
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    },
  };
}

test("a repair that comes back without the record it was called for is refused", async () => {
  const { deps, probed } = partialRepair();
  const r = await runCycle(argsFor(healthyState()), deps);

  // The premise: r6 is missing from the listing and live at its own URL, so this is a
  // repairable loss and the contract does not object to it on volume alone.
  assert.equal(r.diagnosis.cause, "drift");
  assert.deepEqual(r.diagnosis.lostRefs, ["r6"]);
  assert.deepEqual(probed, ["r6"], "r6's permalink is what proves it is not a withdrawal");
  assert.equal(r.diagnosis.withdrawnRefs.length, 0);

  assert.notEqual(r.serving.state, "healed", "a partial repair is not a heal");
  assert.equal(r.incident?.verified, false);
  assert.equal(r.incident?.closedAt, null, "the incident stays open until r6 is back");
  assert.match(String(r.incident?.refusal), /r6/);

  const served = r.serving.rows.map((x) => String(x.id));
  assert.ok(served.includes("r6"), "last-good still holds r6, and r6 is not withdrawn");
});

test("an abandoned record stays in the baseline, so the bar is not lowered", async () => {
  const { deps } = partialRepair();
  const r = await runCycle(argsFor(healthyState()), deps);

  assert.ok(
    r.nextState.baselineRefs.includes("r6"),
    "dropping r6 from the baseline would make its absence unremarkable next cycle"
  );
  assert.equal(
    r.nextState.baselineRows,
    6,
    "accepting 5 as the new baseline lets the next repair drop another record legally"
  );
});

test("a repair that brings the record back is still served as healed", async () => {
  let run = 0;
  const { deps } = partialRepair();
  const r = await runCycle(argsFor(healthyState()), {
    ...deps,
    runScraper: async () => {
      run++;
      return run === 1 ? { rows: WITHOUT_R6, errors: [] } : { rows: ROWS, errors: [] };
    },
  });

  assert.equal(r.serving.state, "healed", "the guard must not reject a repair that worked");
  assert.equal(r.incident?.verified, true);
  assert.equal(r.nextState.baselineRows, 6);
});

// The loop's memory of failing, and what that memory is allowed to change.
//
// Everything else in the engine judges one cycle in isolation. These tests are about
// the thing a single cycle cannot express: that the tenth block should not cost what the
// first one did, that a repair which has failed three times should stop being paid for,
// and that neither of those is ever allowed to delay a withdrawal.
//
// The assertions that matter most are again negative. While a source is cooling, the
// cycle must make NO request. Not a request whose result is discarded: none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, runCycle, type CycleArgs, type CycleDeps, type Row, type SourceState } from "./runner.js";
import {
  advance,
  cooldownMs,
  coolingDown,
  cooldownUntil,
  repairExhausted,
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  REPAIR_BUDGET,
} from "./backoff.js";
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
/** Half the catalogue, which is a 50% drop against a 20% limit. */
const HALF = ROWS.slice(0, 3);

const WALL = {
  status: 200,
  bodyBytes: 900,
  blockSignature: "verify you are a human",
  body: "<html>verify you are a human</html>",
};

interface Calls {
  heal: number;
  runs: number;
  listings: number;
}

function deps(over: Partial<CycleDeps> = {}, at = "2026-08-18T10:00:00.000Z"): { deps: CycleDeps; calls: Calls } {
  const calls: Calls = { heal: 0, runs: 0, listings: 0 };
  const base: CycleDeps = {
    probeListing: async () => {
      calls.listings++;
      return { status: 200, bodyBytes: 5000, blockSignature: null, body: "<html></html>" };
    },
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
    now: () => new Date(at),
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

function seeded(rows: Row[], over: Partial<SourceState> = {}): SourceState {
  return {
    ...emptyState(),
    baselineRefs: rows.map((r) => String(r.id)),
    baselineRows: rows.length,
    lastVerifiedAt: "2026-08-17T10:00:00.000Z",
    lastGoodRows: rows,
    ...over,
  };
}

// --- the arithmetic ---------------------------------------------------------

test("cooldown doubles and then stops doubling", () => {
  assert.equal(cooldownMs(1), BASE_COOLDOWN_MS);
  assert.equal(cooldownMs(2), BASE_COOLDOWN_MS * 2);
  assert.equal(cooldownMs(3), BASE_COOLDOWN_MS * 4);
  assert.equal(cooldownMs(99), MAX_COOLDOWN_MS);
  // Growth without a ceiling is a source that is never read again. Assert the ceiling
  // is reached rather than merely that the number is large.
  assert.ok(cooldownMs(40) <= MAX_COOLDOWN_MS);
  assert.equal(cooldownMs(0), 0);
});

test("a different cause restarts the count rather than adding to it", () => {
  const at = "2026-08-18T10:00:00.000Z";
  const drift2 = advance(advance(null, "drift", at), "drift", at);
  assert.equal(drift2?.count, 2);
  // Two drifts then a block is one block, not a third strike. Otherwise an unrelated
  // earlier failure would put a source straight into a long cooldown.
  const blocked = advance(drift2, "blocked", "2026-08-18T11:00:00.000Z");
  assert.equal(blocked?.cause, "blocked");
  assert.equal(blocked?.count, 1);
  assert.equal(blocked?.since, "2026-08-18T11:00:00.000Z");
});

test("a cycle we vouched for clears the streak", () => {
  const three = { cause: "drift" as const, count: 3, since: "2026-08-18T09:00:00.000Z" };
  assert.equal(advance(three, "healthy", "x"), null);
  // `gone` is the source working correctly. Counting it would let a run of withdrawals
  // put the feed into backoff, which is the opposite of what this system is for.
  assert.equal(advance(three, "gone", "x"), null);
  assert.equal(advance(three, "resurrected", "x"), null);
});

test("only a repairable cause has a repair budget", () => {
  const spent = (cause: "drift" | "blocked" | "gone") => ({ cause, count: REPAIR_BUDGET, since: "x" });
  assert.equal(repairExhausted(spent("drift"), "drift"), true);
  // A block never reaches the healer, so a spent budget on it is meaningless and must
  // not be the thing that refuses the cycle. The block branch already refused it.
  assert.equal(repairExhausted(spent("blocked"), "blocked"), false);
  assert.equal(repairExhausted(spent("gone"), "gone"), false);
  assert.equal(repairExhausted(null, "drift"), false);
  assert.equal(repairExhausted({ cause: "drift", count: REPAIR_BUDGET - 1, since: "x" }, "drift"), false);
  // A different failure gets its own budget. The prompt is built from different
  // evidence, so there is a real reason to expect a different result.
  assert.equal(repairExhausted(spent("drift"), "pagination"), false);
});

test("only a block arms a cooldown", () => {
  const now = new Date("2026-08-18T10:00:00.000Z");
  assert.equal(cooldownUntil({ cause: "drift", count: 5, since: "x" }, now), null);
  assert.equal(cooldownUntil(null, now), null);
  const until = cooldownUntil({ cause: "blocked", count: 1, since: "x" }, now);
  assert.equal(until, new Date(now.getTime() + BASE_COOLDOWN_MS).toISOString());
});

test("an unreadable deadline reads as not cooling", () => {
  const now = new Date("2026-08-18T10:00:00.000Z");
  // The failure mode of a corrupt state file should be one wasted request, not a source
  // that is silently never read again.
  assert.equal(coolingDown("not a date", now), null);
  assert.equal(coolingDown(null, now), null);
  assert.equal(coolingDown(undefined, now), null);
  assert.equal(coolingDown("2026-08-18T09:59:00.000Z", now), null);
  assert.equal(coolingDown("2026-08-18T10:01:00.000Z", now), 60_000);
});

// --- backing off from a wall ------------------------------------------------

test("a block arms a cooldown and counts", async () => {
  const { deps: d } = deps({ probeListing: async () => WALL });
  const r = await runCycle(args(seeded(ROWS)), d);

  assert.equal(r.diagnosis.cause, "blocked");
  assert.equal(r.nextState.streak?.count, 1);
  assert.equal(
    r.nextState.cooldownUntil,
    new Date(Date.parse("2026-08-18T10:00:00.000Z") + BASE_COOLDOWN_MS).toISOString()
  );
});

test("while cooling, the cycle makes no request at all", async () => {
  const { deps: d, calls } = deps();
  const cooling = seeded(ROWS, {
    streak: { cause: "blocked", count: 2, since: "2026-08-18T09:00:00.000Z" },
    cooldownUntil: "2026-08-18T10:05:00.000Z",
  });

  const r = await runCycle(args(cooling), d);

  // The whole point. Backing off that still pays for the scrape is not backing off.
  assert.equal(calls.listings, 0);
  assert.equal(calls.runs, 0);
  assert.equal(calls.heal, 0);
  assert.equal(r.serving.state, "unverified");
  assert.equal(r.incident?.cause, "blocked");
  assert.match(r.incident?.refusal ?? "", /backoff/);
  assert.match(r.incident?.refusal ?? "", /5m remaining/);
  // State is carried forward untouched: a cycle that looked at nothing has learned
  // nothing and must not overwrite the baseline it did not measure.
  assert.deepEqual(r.nextState, cooling);
});

test("a cooling cycle still refuses to serve a record known withdrawn", async () => {
  const { deps: d } = deps();
  const cooling = seeded(ROWS, {
    withdrawnRefs: ["r2"],
    streak: { cause: "blocked", count: 1, since: "2026-08-18T09:00:00.000Z" },
    cooldownUntil: "2026-08-18T10:05:00.000Z",
  });

  const r = await runCycle(args(cooling), d);

  // Backoff decides what we spend, never what we claim. A withdrawal established before
  // the wall went up is still established, and the fallback must apply it.
  const served = r.serving.rows.map((x) => x.id);
  assert.equal(served.includes("r2"), false);
  assert.equal(served.length, 5);
});

test("once the cooldown expires the source is read normally", async () => {
  const { deps: d, calls } = deps({}, "2026-08-18T10:06:00.000Z");
  const expired = seeded(ROWS, {
    streak: { cause: "blocked", count: 2, since: "2026-08-18T09:00:00.000Z" },
    cooldownUntil: "2026-08-18T10:05:00.000Z",
  });

  const r = await runCycle(args(expired), d);

  assert.equal(calls.runs, 1);
  assert.equal(r.diagnosis.cause, "healthy");
  assert.equal(r.serving.state, "verified");
  // Recovery clears the memory. Without this the counter only grows and a source that
  // came back is still one strike from a long sleep.
  assert.equal(r.nextState.streak, null);
  assert.equal(r.nextState.cooldownUntil, null);
});

test("consecutive blocks grow the wait", async () => {
  let state = seeded(ROWS);
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const at = new Date(Date.parse("2026-08-18T10:00:00.000Z") + i * 3_600_000).toISOString();
    const { deps: d } = deps({ probeListing: async () => WALL }, at);
    const r = await runCycle(args(state), d);
    state = r.nextState;
    waits.push(Date.parse(state.cooldownUntil ?? at) - Date.parse(at));
  }
  assert.deepEqual(waits, [BASE_COOLDOWN_MS, BASE_COOLDOWN_MS * 2, BASE_COOLDOWN_MS * 4]);
  assert.equal(state.streak?.count, 3);
});

test("a withdrawal is never put into backoff", async () => {
  const { deps: d } = deps({
    runScraper: async () => ({ rows: ROWS.slice(0, 5), errors: [] }),
    probePermalinks: async (entries) =>
      entries.map((e) => ({ ref: e.ref, status: 404, goneSignature: "no longer available" })),
  });
  const state = seeded(ROWS, { streak: { cause: "drift", count: 2, since: "2026-08-18T09:00:00.000Z" } });

  const r = await runCycle(args(state), d);

  assert.equal(r.diagnosis.cause, "gone");
  assert.equal(r.nextState.streak, null);
  assert.equal(r.nextState.cooldownUntil, null);
});

// --- giving up on a repair --------------------------------------------------

/** A drift the healer cannot fix: half the rows vanish, their permalinks resolve, and
 *  the run after the repair looks exactly like the run before it. */
function unfixableDrift(at: string): { deps: CycleDeps; calls: Calls } {
  const made = deps({}, at);
  // Overridden through the returned object rather than passed as `over`, so the counting
  // in the base deps survives. An override that silently stops counting makes every
  // "was this called" assertion in this file pass for the wrong reason.
  made.deps.runScraper = async () => {
    made.calls.runs++;
    return { rows: HALF, errors: [] };
  };
  return made;
}

test("a repair that keeps failing is eventually stopped", async () => {
  let state = seeded(ROWS);
  const healCalls: number[] = [];

  for (let i = 0; i < REPAIR_BUDGET + 1; i++) {
    const at = new Date(Date.parse("2026-08-18T10:00:00.000Z") + i * 3_600_000).toISOString();
    const { deps: d, calls } = unfixableDrift(at);
    const r = await runCycle(args(state), d);
    state = r.nextState;
    healCalls.push(calls.heal);

    if (i < REPAIR_BUDGET) {
      assert.equal(calls.heal, 1, `cycle ${i} should still try`);
      assert.equal(state.streak?.count, i + 1);
    } else {
      // The budget is spent. The fourth attempt would send a prompt built from the same
      // evidence to the same collector, so it is not sent.
      assert.equal(calls.heal, 0, "the cycle past the budget must not call the healer");
      assert.match(r.incident?.refusal ?? "", /no further repair will be attempted/);
      assert.equal(r.serving.state, "unverified");
    }
  }
  assert.deepEqual(healCalls, [1, 1, 1, 0]);
});

test("giving up on the repair does not stop us reading the source", async () => {
  const { deps: d, calls } = unfixableDrift("2026-08-18T10:00:00.000Z");
  const spent = seeded(ROWS, {
    streak: { cause: "drift", count: REPAIR_BUDGET, since: "2026-08-18T07:00:00.000Z" },
  });

  const r = await runCycle(args(spent), d);

  // What stops is the spending on repairs, not the watching. The moment the source reads
  // cleanly again the streak clears on its own and the budget comes back.
  assert.equal(calls.runs, 1);
  assert.equal(calls.listings, 1);
  assert.equal(calls.heal, 0);
  assert.equal(r.report.rows, 3);
});

test("a source that recovers earns its whole budget back", async () => {
  const spent = seeded(ROWS, {
    streak: { cause: "drift", count: REPAIR_BUDGET - 1, since: "2026-08-18T07:00:00.000Z" },
  });
  const { deps: d } = deps();

  const r = await runCycle(args(spent), d);

  assert.equal(r.diagnosis.cause, "healthy");
  // Two failures then a fix is not two thirds of the way to giving up.
  assert.equal(r.nextState.streak, null);
});

test("a verified repair clears the streak", async () => {
  let after = false;
  const { deps: d } = deps({
    runScraper: async () => {
      const rows = after ? ROWS : HALF;
      after = true;
      return { rows, errors: [] };
    },
  });
  const state = seeded(ROWS, { streak: { cause: "drift", count: 2, since: "2026-08-18T07:00:00.000Z" } });

  const r = await runCycle(args(state), d);

  assert.equal(r.serving.state, "healed");
  assert.equal(r.nextState.streak, null);
});

test("a repair that never left the building is not charged to the budget", async () => {
  const { deps: d, calls } = deps({
    runScraper: async () => ({ rows: HALF, errors: [] }),
    heal: async () => {
      calls.heal++;
      return { ok: false, durationMs: 5, status: "heal_busy" };
    },
  });
  const state = seeded(ROWS, { streak: { cause: "drift", count: 1, since: "2026-08-18T07:00:00.000Z" } });

  const r = await runCycle(args(state), d);

  assert.equal(r.incident?.healDeferred, true);
  // The budget counts repairs that were tried and failed. Charging it for one that was
  // never attempted would exhaust the budget on a busy collector and refuse the source a
  // fix it had not yet been given.
  assert.equal(r.nextState.streak?.count, 1);
});

test("a repair that fabricated a withdrawn record is charged to the budget", async () => {
  let after = false;
  const { deps: d } = deps({
    runScraper: async () => {
      // The repair "recovers" r9, which we have already confirmed is gone.
      const rows = after ? [...HALF, row("r9")] : HALF;
      after = true;
      return { rows, errors: [] };
    },
  });
  const state = seeded(ROWS, {
    withdrawnRefs: ["r9"],
    streak: { cause: "drift", count: 1, since: "2026-08-18T07:00:00.000Z" },
  });

  const r = await runCycle(args(state), d);

  assert.match(r.incident?.refusal ?? "", /fabricated/);
  // It ran, it produced output, and the output was worse than nothing.
  assert.equal(r.nextState.streak?.count, 2);
});

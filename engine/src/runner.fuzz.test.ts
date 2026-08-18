// What must stay true of the persisted state across a run of cycles.
//
// `runCycle` is a state machine, and the failures that matter in a state machine are
// not wrong verdicts on one input. They are sequences: a record marked withdrawn on
// Monday that quietly stops being withdrawn on Wednesday, a baseline that advances on a
// cycle we refused, output promoted to last-good without ever satisfying the contract.
// Nothing in the example tests exercises more than one cycle.
//
// So this drives sequences. Each seed produces a chain of cycles against a source that
// breaks, recovers, gets blocked, loses records, has them come back, and returns
// nonsense from the healer, and after every cycle the invariants below are checked
// against the state that would actually be written to disk.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyState, runCycle, type CycleDeps, type Row, type SourceState } from "./runner.js";
import type { SourceContract } from "./contract.js";

const CONTRACT: SourceContract = {
  version: "fuzz@1",
  sourceId: "tradewell",
  minRows: 2,
  maxRowDropRate: 0.2,
  fields: {
    id: { type: "string", maxNullRate: 0, minLength: 2 },
    title: { type: "string", maxNullRate: 0, minLength: 3 },
  },
};

const row = (id: string): Row => ({ id, title: `item ${id}` });
const CATALOGUE = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"].map(row);
const refOf = (r: Row): string => String((r as Record<string, unknown>).id ?? "");

function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

/** One cycle's worth of world: what the page says, what came back, what resolves. */
interface Step {
  blocked: boolean;
  present: Row[];
  /** Refs whose permalink still answers a clean 200. */
  live: string[];
  healOk: boolean;
  healStatus: string;
  /** What a successful heal makes the collector return next. */
  afterHeal: Row[];
}

function step(r: () => number): Step {
  const present = CATALOGUE.filter(() => r() > 0.35);
  const missing = CATALOGUE.filter((x) => !present.includes(x)).map(refOf);
  // Each missing ref independently either still resolves, 404s, or does not answer.
  const live = missing.filter(() => r() < 0.45);
  const healOk = r() < 0.5;
  return {
    blocked: r() < 0.15,
    present,
    live,
    healOk,
    healStatus: healOk ? "done" : (["heal_call_failed", "heal_busy", "failed"][Math.floor(r() * 3)] ?? "failed"),
    afterHeal: r() < 0.6 ? CATALOGUE : CATALOGUE.slice(0, 1),
  };
}

function deps(s: Step, clock: { t: number }, missingResolver: (ref: string) => number): CycleDeps {
  let healed = false;
  return {
    async probeListing() {
      const body = s.blocked ? "<html>checking your browser</html>" : "<html>ok</html>";
      return {
        status: 200,
        bodyBytes: body.length,
        blockSignature: s.blocked ? "checking your browser" : null,
        body,
      };
    },
    async runScraper() {
      clock.t += 1000;
      return { rows: healed ? s.afterHeal : s.present, errors: [] };
    },
    async probePermalinks(entries) {
      return entries.map((e) => ({
        ref: e.ref,
        status: missingResolver(e.ref),
        goneSignature: null,
      }));
    },
    async heal() {
      clock.t += 5000;
      healed = s.healOk;
      return { ok: s.healOk, durationMs: 5000, status: s.healStatus };
    },
    observeMarkup: () => ({
      listingStatus: 200,
      listingBytes: 100,
      deadSelectors: [],
      observedHooks: [],
      observedLabels: [],
    }),
    now: () => new Date(clock.t),
  };
}

const SEEDS = 400;
const CYCLES = 5;

describe("state invariants across a sequence of cycles", async () => {
  it("never promotes output to last-good unless that run satisfied the contract", async () => {
    // The one that keeps a stale-but-true feed from becoming a fresh-and-wrong one.
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      let state: SourceState = emptyState();
      const clock = { t: Date.parse("2026-08-18T00:00:00.000Z") };

      for (let c = 0; c < CYCLES; c++) {
        const s = step(r);
        const before = state;
        const result = await runCycle(
            {
              sourceId: "tradewell",
              collectorId: "c_fuzz",
              url: "https://f.test/",
              contract: CONTRACT,
              state,
              permalinkFor: (ref) => `https://f.test/${ref}`,
              refOf,
              rowsPerPage: 4,
            },
            deps(s, clock, (ref) => (s.live.includes(ref) ? 200 : 404))
        );
        state = result.nextState;

        const changed =
          JSON.stringify(state.lastGoodRows) !== JSON.stringify(before.lastGoodRows);
        if (changed) {
          assert.ok(
            result.serving.state === "verified" || result.serving.state === "healed",
            `seed ${seed} cycle ${c}: last-good replaced while serving ${result.serving.state}`
          );
        }
      }
    }
  });

  it("only ever removes a withdrawn ref by reporting it as resurrected", async () => {
    // A record published as withdrawn must not quietly stop being withdrawn. If it
    // comes back, that is an event with an incident attached, not a silent edit.
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      let state: SourceState = emptyState();
      const clock = { t: Date.parse("2026-08-18T00:00:00.000Z") };

      for (let c = 0; c < CYCLES; c++) {
        const s = step(r);
        const before = state.withdrawnRefs;
        const result = await runCycle(
            {
              sourceId: "tradewell",
              collectorId: "c_fuzz",
              url: "https://f.test/",
              contract: CONTRACT,
              state,
              permalinkFor: (ref) => `https://f.test/${ref}`,
              refOf,
              rowsPerPage: 4,
            },
            deps(s, clock, (ref) => (s.live.includes(ref) ? 200 : 404))
        );
        state = result.nextState;

        const dropped = before.filter((x) => !state.withdrawnRefs.includes(x));
        for (const ref of dropped) {
          assert.ok(
            result.resurrectedRefs.includes(ref),
            `seed ${seed} cycle ${c}: ${ref} stopped being withdrawn without being reported`
          );
        }
      }
    }
  });

  it("opens an incident for every cycle that was not healthy", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      let state: SourceState = emptyState();
      const clock = { t: Date.parse("2026-08-18T00:00:00.000Z") };

      for (let c = 0; c < CYCLES; c++) {
        const s = step(r);
        const result = await runCycle(
            {
              sourceId: "tradewell",
              collectorId: "c_fuzz",
              url: "https://f.test/",
              contract: CONTRACT,
              state,
              permalinkFor: (ref) => `https://f.test/${ref}`,
              refOf,
              rowsPerPage: 4,
            },
            deps(s, clock, (ref) => (s.live.includes(ref) ? 200 : 404))
        );
        state = result.nextState;

        if (result.diagnosis.cause !== "healthy") {
          assert.ok(
            result.incident !== null,
            `seed ${seed} cycle ${c}: ${result.diagnosis.cause} with no incident`
          );
        }
        if (result.incident !== null) {
          // A refusal and an attempted repair are different events and must not both
          // be claimed. This is the distinction the incident log exists to keep.
          assert.ok(
            !(result.incident.healAttempted && result.incident.healDeferred),
            `seed ${seed} cycle ${c}: incident both attempted and deferred`
          );
        }
      }
    }
  });

  it("never serves a record confirmed withdrawn in the same cycle", async () => {
    // This property is here because its absence was a real defect, and because the
    // comment I wrote in classify.fuzz.test.ts explicitly reasoned it away: a
    // withdrawal alongside a genuine loss does not block the repair, I said, because
    // the repair addresses the loss and the withdrawn record cannot come back.
    //
    // It can. The healer's entire failure mode is producing rows it was asked for, and
    // the post-repair check only re-ran the contract, which knows nothing about
    // withdrawals. A record that 404s at its own URL was re-extracted, passed the
    // contract, and was served as `healed`.
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      let state: SourceState = emptyState();
      const clock = { t: Date.parse("2026-08-18T00:00:00.000Z") };

      for (let c = 0; c < CYCLES; c++) {
        const s = step(r);
        const result = await runCycle(
          {
            sourceId: "tradewell",
            collectorId: "c_fuzz",
            url: "https://f.test/",
            contract: CONTRACT,
            state,
            permalinkFor: (ref) => `https://f.test/${ref}`,
            refOf,
            rowsPerPage: 4,
          },
          deps(s, clock, (ref) => (s.live.includes(ref) ? 200 : 404))
        );
        state = result.nextState;

        const served = new Set(result.serving.rows.map(refOf));
        for (const ref of result.diagnosis.withdrawnRefs) {
          assert.ok(
            !served.has(ref),
            `seed ${seed} cycle ${c}: served ${ref} after confirming it withdrawn`
          );
          assert.ok(
            !state.baselineRefs.includes(ref),
            `seed ${seed} cycle ${c}: ${ref} stayed in the baseline after being withdrawn`
          );
        }
      }
    }
  });

  it("never serves rows it did not have", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed);
      let state: SourceState = emptyState();
      const clock = { t: Date.parse("2026-08-18T00:00:00.000Z") };

      for (let c = 0; c < CYCLES; c++) {
        const s = step(r);
        const known = new Set([...s.present, ...s.afterHeal, ...state.lastGoodRows].map(refOf));
        const result = await runCycle(
            {
              sourceId: "tradewell",
              collectorId: "c_fuzz",
              url: "https://f.test/",
              contract: CONTRACT,
              state,
              permalinkFor: (ref) => `https://f.test/${ref}`,
              refOf,
              rowsPerPage: 4,
            },
            deps(s, clock, (ref) => (s.live.includes(ref) ? 200 : 404))
        );
        state = result.nextState;

        for (const served of result.serving.rows) {
          assert.ok(
            known.has(refOf(served)),
            `seed ${seed} cycle ${c}: served ${refOf(served)}, which came from nowhere`
          );
        }
      }
    }
  });
});

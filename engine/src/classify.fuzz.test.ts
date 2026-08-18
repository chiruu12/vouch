// Properties the classifier must hold for every input, not just the ones we thought of.
//
// The example-based tests in classify.test.ts each pin a scenario somebody imagined.
// Every hole found in this file's subject so far was a case nobody imagined: a 200 whose
// body said the record was gone, a permalink that redirected somewhere else, a probe
// that returned 403. Those were found by review, one at a time, after shipping.
//
// This generates inputs instead. It cannot find a case the properties do not describe,
// but it does not need anybody to think of the case first, and the properties below are
// the actual guarantees rather than a restatement of the implementation.
//
// Deterministic on purpose: a seeded generator, so a failure is reproducible from the
// seed printed in the assertion rather than being a story about a run nobody can repeat.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, type ListingProbe, type PermalinkProbe } from "./classify.js";
import type { ContractReport, FieldReport } from "./contract.js";

/** xorshift32. Small, seeded, and good enough to shuffle statuses around. */
function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

/** Statuses a permalink can answer with, including the ones that broke this before. */
const STATUSES = [200, 200, 200, 404, 410, 0, 500, 503, 403, 429, 408, 301, 302, 418];
const GONE_BODIES = [null, null, null, "no longer available", "permalink redirected to /x"];
const BLOCK_SIGS = [null, null, null, null, "checking your browser", "cf-challenge"];

interface Generated {
  seed: number;
  report: ContractReport;
  listing: ListingProbe;
  baselineRefs: string[];
  currentRefs: string[];
  permalinks: PermalinkProbe[];
  rowsPerPage?: number;
}

function generate(seed: number): Generated {
  const r = rng(seed);
  const total = 1 + Math.floor(r() * 14);
  const baselineRefs = Array.from({ length: total }, (_, i) => `R-${i + 1}`);

  // Keep a random subset, sometimes none, sometimes all.
  const kept = baselineRefs.filter(() => r() > 0.45);
  const currentRefs = kept;
  const missing = baselineRefs.filter((x) => !kept.includes(x));

  // Probe results for the missing refs, sometimes incomplete, sometimes with extras.
  const permalinks: PermalinkProbe[] = [];
  for (const ref of missing) {
    if (r() < 0.12) continue; // ref absent from the probe array entirely
    const status = pick(r, STATUSES);
    const goneSignature = status === 200 ? pick(r, GONE_BODIES) : null;
    permalinks.push({ ref, status, goneSignature });
  }
  if (r() < 0.2) permalinks.push({ ref: "R-not-missing", status: 404, goneSignature: null });

  const fields: FieldReport[] = ["id", "title", "price"].map((field) => {
    const breached = r() < 0.3;
    return {
      field,
      nullRate: breached ? 1 : 0,
      nullRateLimit: 0,
      typeErrors: 0,
      breached,
      sampleRefs: [],
    };
  });

  const rows = currentRefs.length;
  const report: ContractReport = {
    sourceId: "arcadia",
    contractVersion: "fuzz@1",
    at: "2026-08-18T00:00:00.000Z",
    rows,
    baselineRows: total,
    rowDropRate: total === 0 ? null : (total - rows) / total,
    passed: rows === total && fields.every((f) => !f.breached),
    breaches: fields.filter((f) => f.breached).map((f) => `field ${f.field} breached`),
    fields,
  };

  const listing: ListingProbe = {
    status: pick(r, [200, 200, 200, 200, 403, 429, 503]),
    bodyBytes: 500,
    blockSignature: pick(r, BLOCK_SIGS),
    body: "<html></html>",
  };

  const perPage = r() < 0.5 ? 1 + Math.floor(r() * 8) : undefined;
  return {
    seed,
    report,
    listing,
    baselineRefs,
    currentRefs,
    permalinks,
    ...(perPage !== undefined ? { rowsPerPage: perPage } : {}),
  };
}

const RUNS = 3000;

describe("classifier invariants over generated input", () => {
  it("never authorises a repair while any missing record is unaccounted for", () => {
    // The guarantee the whole project rests on, stated as a property rather than a
    // list of scenarios: if we are going to rewrite selectors, every record missing
    // from this run must be accounted for first. Accounted for means one of two
    // things, and the distinction matters.
    //
    // Confirmed still published: a clean 200. These are what the repair is for.
    //
    // Confirmed withdrawn: recorded, preserved as last-good, and never sent to the
    // healer. A withdrawal alongside a genuine extraction loss does not block the
    // repair, because the repair addresses the loss and the withdrawal is already
    // marked. What must never happen is repairing while a record's fate is unknown.
    for (let seed = 1; seed <= RUNS; seed++) {
      const g = generate(seed);
      const d = classify(g);
      if (!d.healable) continue;

      assert.equal(
        d.unresolvedRefs.length,
        0,
        `seed ${seed}: healable with ${d.unresolvedRefs.length} unresolved ref(s)`
      );

      const byRef = new Map(g.permalinks.map((p) => [p.ref, p]));
      const missing = g.baselineRefs.filter((x) => !g.currentRefs.includes(x));
      for (const ref of missing) {
        if (d.withdrawnRefs.includes(ref)) continue; // accounted for, and never healed
        const p = byRef.get(ref);
        assert.ok(p !== undefined, `seed ${seed}: healable with ${ref} never probed`);
        assert.equal(
          p.status,
          200,
          `seed ${seed}: healable while ${ref} answered ${p.status}`
        );
        assert.equal(
          p.goneSignature ?? null,
          null,
          `seed ${seed}: healable while ${ref} said "${p.goneSignature}"`
        );
      }

      // And a withdrawal is never handed to the healer as something to go and find.
      for (const ref of d.withdrawnRefs) {
        assert.ok(
          !d.lostRefs.includes(ref),
          `seed ${seed}: ${ref} is both withdrawn and queued for repair`
        );
      }
    }
  });

  it("never marks a record withdrawn without a signal that says so", () => {
    // The opposite failure, and the reason GONE_MARKERS is a short list: calling a
    // live record withdrawn removes a real recall from the feed.
    for (let seed = 1; seed <= RUNS; seed++) {
      const g = generate(seed);
      const d = classify(g);
      const byRef = new Map(g.permalinks.map((p) => [p.ref, p]));
      for (const ref of d.withdrawnRefs) {
        const p = byRef.get(ref);
        assert.ok(p !== undefined, `seed ${seed}: ${ref} withdrawn with no probe`);
        const withdrawnStatus = p.status === 404 || p.status === 410;
        const goneBody = p.status === 200 && (p.goneSignature ?? null) !== null;
        assert.ok(
          withdrawnStatus || goneBody,
          `seed ${seed}: ${ref} withdrawn on status ${p.status} with no gone signal`
        );
      }
    }
  });

  it("keeps the three ref categories disjoint and inside the missing set", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const g = generate(seed);
      const d = classify(g);
      const missing = new Set(g.baselineRefs.filter((x) => !g.currentRefs.includes(x)));
      const all = [...d.withdrawnRefs, ...d.lostRefs, ...d.unresolvedRefs];

      assert.equal(
        new Set(all).size,
        all.length,
        `seed ${seed}: a ref appears in more than one category`
      );
      for (const ref of all) {
        assert.ok(missing.has(ref), `seed ${seed}: ${ref} categorised but never missing`);
      }
    }
  });

  it("refuses whenever the listing itself was blocked, whatever else is true", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const g = generate(seed);
      const blocked = g.listing.blockSignature !== null || g.listing.status === 403 || g.listing.status === 429;
      if (!blocked) continue;
      const d = classify(g);
      assert.equal(d.cause, "blocked", `seed ${seed}: block not detected`);
      assert.equal(d.healable, false, `seed ${seed}: healable despite a block`);
    }
  });

  it("always produces a cause and evidence for it", () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const g = generate(seed);
      const d = classify(g);
      assert.ok(
        ["drift", "pagination", "blocked", "gone", "healthy"].includes(d.cause),
        `seed ${seed}: unknown cause ${d.cause}`
      );
      if (d.cause !== "healthy") {
        assert.ok(d.evidence.length > 0, `seed ${seed}: ${d.cause} with no evidence`);
      }
    }
  });
});

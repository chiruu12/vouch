// The wire layer may make an answer cheaper. It may not make it say something else.
//
// That is the whole risk of compaction: a field dropped to save four tokens is a claim
// withdrawn, and the two are indistinguishable in a diff. So every test here compares
// the digest and the JSON form against the answer they were both built from, rather than
// against a string somebody typed out once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compactAnswer, dense, digestAnswer, digestBreakage, shortTime , digestQuarantine } from "./wire.js";
import { adviseRetry, measuredRepairMs, type ContextAnswer, type BreakageReport } from "./context.js";
import type { PubIncident } from "./snapshot.js";

const ANSWER = (over: Partial<ContextAnswer> = {}): ContextAnswer => ({
  query: "breville kettle",
  askedAt: "2026-08-19T12:34:56.789Z",
  caveat: "matched on product line, not on unit",
  asserted: [],
  withheld: [],
  caution: null,
  refusal: null,
  refusalCode: null,
  ...over,
});

const HIT = {
  ref: "R-1",
  title: "Breville Smart Kettle Recalled",
  brand: "Breville",
  hazard: "Burn hazard",
  risk: "Serious" as const,
  action: "Stop using it",
  permalink: "https://example.test/r/R-1",
  published: "2026-07-01",
  confidence: 0.82,
  basis: "brand+product" as const,
  matchedTokens: ["breville", "kettle"],
  vouch: {
    sourceId: "cpsc" as const,
    sourceLabel: "US CPSC",
    state: "verified" as const,
    lastVerifiedAt: "2026-08-19T08:00:00.000Z",
    stale: false,
    synthetic: false,
  },
};

test("a refusal is the first line of the digest and nothing follows it that reads as an answer", () => {
  const d = digestAnswer(ANSWER({ refusal: "cannot report absence", refusalCode: "absence_unverifiable" }));
  assert.ok(d.startsWith("REFUSED absence_unverifiable\n"), d.slice(0, 40));
  assert.ok(!d.includes("RECALL "), "a refusal must not be followed by anything shaped like a hit");
  assert.ok(!d.includes("NONE"), "nor by anything shaped like a clean miss");
});

test("the refusal code is the first key of the compact JSON too", () => {
  const c = compactAnswer(ANSWER({ refusal: "no", refusalCode: "query_too_short" }));
  assert.equal(Object.keys(c)[0], "refused");
});

test("provenance is stated once per source, not once per record", () => {
  const three = ANSWER({
    asserted: [HIT, { ...HIT, ref: "R-2" }, { ...HIT, ref: "R-3" }],
  });
  const c = compactAnswer(three) as { recalls: { src: string }[]; src: Record<string, unknown> };
  assert.equal(Object.keys(c.src).length, 1, "one source, one provenance block");
  assert.deepEqual(c.recalls.map((r) => r.src), ["cpsc", "cpsc", "cpsc"]);

  const d = digestAnswer(three);
  assert.equal(d.split("\n").filter((l) => l.startsWith("SRC ")).length, 1);
  assert.equal(d.split("\n").filter((l) => l.startsWith("RECALL ")).length, 3);
});

test("compaction never drops what the answer asserted", () => {
  const a = ANSWER({ asserted: [HIT] });
  const d = digestAnswer(a);
  for (const must of [HIT.ref, HIT.title, HIT.hazard, HIT.action, HIT.permalink, "0.82", HIT.basis]) {
    assert.ok(d.includes(must), `digest lost ${must}`);
  }
  const c = JSON.stringify(compactAnswer(a));
  for (const must of [HIT.ref, HIT.title, HIT.hazard, HIT.permalink]) {
    assert.ok(c.includes(must), `json lost ${must}`);
  }
});

test("a stale source is marked stale in both forms", () => {
  const stale = { ...HIT, vouch: { ...HIT.vouch, state: "unverified" as const, stale: true } };
  const a = ANSWER({ asserted: [stale], caution: "one source is stale" });
  assert.match(digestAnswer(a), /CAUTION one source is stale/);
  assert.match(digestAnswer(a), /SRC cpsc .*unverified/);
  assert.equal((compactAnswer(a) as { src: Record<string, { stale?: boolean }> }).src.cpsc?.stale, true);
});

test("a synthetic fixture says so on the wire", () => {
  // The one label that must survive compaction whatever it costs. A fixture presented as
  // a real notice is the failure this project would least survive.
  const fake = { ...HIT, vouch: { ...HIT.vouch, synthetic: true } };
  assert.match(digestAnswer(ANSWER({ asserted: [fake] })), /SYNTHETIC/);
  assert.equal((compactAnswer(ANSWER({ asserted: [fake] })) as { src: Record<string, { synthetic?: boolean }> }).src.cpsc?.synthetic, true);
});

test("a clean miss is stated, not left as silence", () => {
  // An empty payload and "we checked and found nothing" are the same bytes and different
  // claims. The digest says which one it is.
  assert.match(digestAnswer(ANSWER()), /^NONE /);
});

test("dense drops what carries nothing, including a value that means nothing", () => {
  assert.deepEqual(dense({ a: 1, b: null, c: "", d: [], e: "Unknown", f: "x" }), { a: 1, f: "x" });
  assert.deepEqual(dense({ n: 0, no: false }), { n: 0, no: false }, "zero and false are values");
});

test("timestamps are cut to the minute", () => {
  assert.equal(shortTime("2026-08-19T12:34:56.789Z"), "2026-08-19 12:34");
  assert.equal(shortTime(null), null);
});

// --- retry advice ------------------------------------------------------------

test("a withdrawal never advises a retry", () => {
  // The project's central claim, restated where an agent will act on it. Telling a
  // caller to wait implies something is coming back, and nothing is.
  const a = adviseRetry("gone", false, false, 300_000);
  assert.equal(a.retry, false);
  assert.match(a.why, /withdrawn/);
});

test("a block advises a retry but says a repair cannot help", () => {
  const a = adviseRetry("blocked", false, false, null);
  assert.equal(a.retry, true);
  assert.match(a.why, /repair cannot fix/);
});

test("a repairable cause quotes the time repairs on that source actually took", () => {
  const a = adviseRetry("pagination", true, false, 347_600);
  assert.equal(a.retry, true);
  assert.equal(a.retry === true ? a.afterMs : 0, 347_600);
  assert.match(a.why, /348s/);
});

test("a repairable cause with no measured repair says so instead of guessing", () => {
  const a = adviseRetry("drift", true, false, null);
  assert.match(a.why, /no repair on this source has been verified yet/);
});

test("a resurrection is not breakage", () => {
  // An open incident that is good news. Treating it as a failure would tell a caller to
  // wait for a repair that is never coming.
  const a = adviseRetry("resurrected", false, false, null);
  assert.equal(a.retry, false);
  assert.match(a.why, /nothing is broken/);
});

test("the measured repair time is the median, so one outlier cannot set the wait", () => {
  // `cause` is part of the fixture because the filter reads it: only causes a repair
  // actually ran for count toward the wait. It was omitted here while every verified
  // incident counted, which is how a withdrawal's zero got into tradewell's median.
  const inc = (mttrMs: number | null, verified: boolean): PubIncident =>
    ({ sourceId: "tradewell", cause: "drift", verified, mttrMs } as unknown as PubIncident);
  const set = [inc(300_000, true), inc(310_000, true), inc(900_000, true)];
  assert.equal(measuredRepairMs(set, "tradewell"), 310_000);
  assert.equal(measuredRepairMs([inc(1, false)], "tradewell"), null, "an unverified repair is not a measurement");
  assert.equal(measuredRepairMs([], "tradewell"), null);
});

test("the breakage digest puts the retry decision on its own line", () => {
  const b: BreakageReport = {
    at: "2026-08-19T12:00:00Z",
    healthy: false,
    canReportAbsence: false,
    sources: [
      {
        id: "cpsc",
        label: "US CPSC",
        state: "unverified",
        cause: "gone",
        healable: false,
        openedAt: "2026-08-19T11:00:00Z",
        repairDeferred: false,
        breaches: ["row count fell 30.0%"],
        advice: { retry: false, why: "the records were withdrawn" },
      },
    ],
  };
  const d = digestBreakage(b);
  assert.match(d, /^HEALTHY false\s+CAN_REPORT_ABSENCE false/);
  assert.match(d, /BROKEN cpsc unverified cause=gone healable=false/);
  assert.match(d, /NO_RETRY the records were withdrawn/);
});

// --- the quarantine digest -------------------------------------------------

const near = (over = {}) => ({
  ref: "APS-2026-0406",
  title: "Iselin Kitchen 6L pressure cooker, IK-PC6",
  confidence: 0.35,
  basis: "brand+product" as const,
  reason: "contradicted: recall covers 6L; this listing states 8L",
  vouch: {
    sourceId: "arcadia" as const,
    sourceLabel: "Arcadia Product Safety (synthetic)",
    state: "verified" as const,
    lastVerifiedAt: "2026-08-18T08:48:12.595Z",
    stale: false,
    synthetic: true,
  },
  ...over,
});

test("a withheld record names the source it was withheld from", () => {
  // Without `src=` on the line, a near-miss reads as an ordinary regulator notice. The
  // caller asked for withheld records on purpose, so it is entitled to know whose.
  const d = digestQuarantine([near()]);

  assert.match(d, /^NEAR APS-2026-0406 conf=0\.35 basis=brand\+product src=arcadia held=/m);
  assert.match(d, /Iselin Kitchen 6L pressure cooker/);
});

test("a withheld fixture record says it is a fixture", () => {
  // The promise that failed here and nowhere else: "fixtures are always labelled
  // synthetic" held on every page and on the asserted path, and this tool renders on no
  // page, so nothing caught that it did not hold here.
  assert.match(digestQuarantine([near()]), /SRC arcadia .*\| SYNTHETIC FIXTURE/);
});

test("a withheld record from a real source is not labelled a fixture", () => {
  const real = near({
    vouch: {
      sourceId: "cpsc" as const,
      sourceLabel: "US CPSC",
      state: "verified" as const,
      lastVerifiedAt: "2026-08-17T13:13:32.000Z",
      stale: false,
      synthetic: false,
    },
  });

  const d = digestQuarantine([real]);
  assert.match(d, /src=cpsc/);
  assert.doesNotMatch(d, /SYNTHETIC FIXTURE/);
});

test("nothing quarantined says so rather than returning an empty reply", () => {
  assert.equal(digestQuarantine([]), "NONE nothing resembled this closely enough to quarantine");
});

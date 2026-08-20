// The context service, tested for the one thing a caller is entitled to build on:
// it either asserts or it refuses, and what it will not vouch for is not in the payload.
//
// The asymmetry is the substance here. An unverified source may still report a recall
// it saw, because a notice does not expire, and may not report that it found nothing,
// because it is unverified for the very reason that makes silence meaningless. Both
// halves are tested against the same broken snapshot, because a rule that only ever
// gets exercised in one direction is a rule nobody has checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recallContext, quarantinedFor, vouchReport, breakageReport, measuredRepairMs } from "./context.js";
import type { PubIncident } from "./snapshot.js";
import type { PubRecall, PubSource, Snapshot } from "./snapshot.js";
import { MATCH_CAVEAT, PUBLISH_THRESHOLD } from "./match.js";
import type { RecordState } from "./types.js";

const NOW = new Date("2026-08-19T12:00:00Z");

function prov(sourceId: "cpsc" | "arcadia", trust: RecordState) {
  return {
    sourceId,
    sourceLabel: sourceId === "cpsc" ? "US CPSC" : "Arcadia Recalls",
    scraped: sourceId === "arcadia",
    synthetic: sourceId === "arcadia",
    contractVersion: "1.0.0",
    trust,
    fetchedAt: "2026-08-19T08:00:00Z",
    lastVerifiedAt: trust === "verified" || trust === "healed" ? "2026-08-19T08:00:00Z" : null,
    heals: 0,
  };
}

function recall(over: Partial<PubRecall> & { ref: string; title: string }): PubRecall {
  return {
    permalink: `https://example.test/recall/${over.ref}`,
    brand: null,
    hazard: "Fire hazard",
    risk: "Serious",
    category: null,
    affectedUnits: null,
    published: "2026-07-01",
    action: "Stop using it",
    provenance: prov("cpsc", "verified"),
    onSale: [],
    quarantined: [],
    ...over,
  } as PubRecall;
}

function source(id: "cpsc" | "arcadia", trust: RecordState, over: Partial<PubSource> = {}): PubSource {
  return {
    id,
    label: id === "cpsc" ? "US CPSC" : "Arcadia Recalls",
    scraped: id === "arcadia",
    synthetic: id === "arcadia",
    collectorId: null,
    url: "https://example.test",
    contractVersion: "1.0.0",
    trust,
    rows: 20,
    baselineRows: 20,
    contractPassed: trust === "verified" || trust === "healed",
    breaches: [],
    lastVerifiedAt: "2026-08-19T08:00:00Z",
    withdrawnRefs: [],
    heals: 0,
    ...over,
  };
}

const KETTLE = recall({
  ref: "R-1",
  title: "Breville Smart Kettle Recalled Due to Serious Burn Hazard",
  brand: "Breville",
});

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    generatedAt: "2026-08-19T08:00:00Z",
    caveat: MATCH_CAVEAT,
    publishThreshold: PUBLISH_THRESHOLD,
    sources: [source("cpsc", "verified"), source("arcadia", "verified")],
    recalls: [KETTLE],
    withdrawn: [],
    incidents: [],
    study: {} as never,
    totals: {} as never,
    ...over,
  };
}

/** The same feed after a cycle that failed its contract on a row-count cliff. */
function unverifiedCpsc(): Snapshot {
  return snapshot({
    sources: [
      source("cpsc", "unverified", {
        contractPassed: false,
        rows: 14,
        breaches: ["row count fell 30.0% against a baseline of 20, limit 20.0%"],
      }),
      source("arcadia", "verified"),
    ],
    recalls: [{ ...KETTLE, provenance: prov("cpsc", "unverified") }],
  });
}

test("a match is asserted with the tokens it rests on", () => {
  const a = recallContext(snapshot(), "Breville Smart Kettle, used, good condition", NOW);
  assert.equal(a.refusal, null);
  assert.equal(a.asserted.length, 1);
  const hit = a.asserted[0]!;
  assert.equal(hit.ref, "R-1");
  assert.ok(hit.confidence >= PUBLISH_THRESHOLD);
  assert.ok(hit.matchedTokens.length > 0, "a caller must be able to check the match itself");
  assert.equal(hit.vouch.state, "verified");
  assert.equal(hit.vouch.stale, false);
  assert.equal(a.caveat, MATCH_CAVEAT, "the unit-versus-product-line caveat always travels");
});

test("a stale source may still report the recall it saw", () => {
  // A notice does not expire. Withholding a real recall because our scraper broke
  // afterwards would be the worse failure, so the hit stands and is dated.
  const a = recallContext(unverifiedCpsc(), "Breville Smart Kettle", NOW);
  assert.equal(a.refusal, null, "a hit is not refused for staleness");
  assert.equal(a.asserted.length, 1);
  assert.equal(a.asserted[0]!.vouch.stale, true);
  assert.match(String(a.caution), /cannot currently vouch for/);
  assert.match(String(a.caution), /US CPSC/);
});

test("a stale source may NOT report that it found nothing", () => {
  // The other half of the same rule, and the reason this module exists. The source is
  // unverified because it failed its contract, and the usual way to fail one is to lose
  // rows, so silence from it is not evidence of absence.
  const a = recallContext(unverifiedCpsc(), "bluetooth headphones", NOW);
  assert.equal(a.asserted.length, 0);
  assert.notEqual(a.refusal, null, "a miss from an unverified source must be refused");
  assert.match(String(a.refusal), /not recalled/);
  assert.match(String(a.refusal), /row count fell 30\.0%/, "the refusal cites the actual breach");
});

test("a healthy source may report that it found nothing", () => {
  const a = recallContext(snapshot(), "bluetooth headphones", NOW);
  assert.equal(a.refusal, null, "absence is reportable when every recall source is current");
  assert.equal(a.asserted.length, 0);
  assert.equal(a.caution, null);
});

test("a recall source missing from the snapshot is a refusal, not a pass", () => {
  // The failure a loop over the snapshot's own sources cannot see. A source vanishes
  // from a build for the same reasons that should stop us reporting absence.
  const a = recallContext(snapshot({ sources: [source("arcadia", "verified")] }), "bluetooth headphones", NOW);
  assert.notEqual(a.refusal, null);
  assert.match(String(a.refusal), /missing from this snapshot entirely/);
});

test("a refusal and an assertion never appear together", () => {
  // The invariant a caller builds on. Anything that returns both is a payload somebody
  // will read the wrong half of.
  const cases: Snapshot[] = [snapshot(), unverifiedCpsc(), snapshot({ sources: [] }), snapshot({ recalls: [] })];
  for (const snap of cases) {
    for (const q of ["Breville Smart Kettle", "bluetooth headphones", "x", "  "]) {
      const a = recallContext(snap, q, NOW);
      if (a.refusal !== null) {
        assert.equal(a.asserted.length, 0, `refused and asserted at once for ${JSON.stringify(q)}`);
      }
    }
  }
});

test("a refusal always carries a code, and an answer never does", () => {
  // The pairing a caller builds its control flow on. A sentence without a code cannot be
  // branched on; a code without a sentence cannot be relayed to a person.
  const cases: [Snapshot, string][] = [
    [snapshot(), "Breville Smart Kettle"],
    [snapshot(), "bluetooth headphones"],
    [snapshot(), "ab"],
    [unverifiedCpsc(), "bluetooth headphones"],
    [unverifiedCpsc(), "Breville Smart Kettle"],
    [snapshot({ sources: [] }), "anything at all"],
  ];
  const seen = new Set<string>();
  for (const [snap, q] of cases) {
    const a = recallContext(snap, q, NOW);
    assert.equal(
      a.refusal === null,
      a.refusalCode === null,
      `refusal and code disagree for ${JSON.stringify(q)}`
    );
    if (a.refusalCode !== null) seen.add(a.refusalCode);
  }
  // Both codes are reachable. A closed set nobody can reach half of is not a contract.
  assert.deepEqual([...seen].sort(), ["absence_unverifiable", "query_too_short"]);
});

test("a near miss is counted and its content is withheld", () => {
  const near = recall({ ref: "R-2", title: "Generic Electric Kettle Recalled Due to Burn Hazard", brand: "Nobody" });
  const a = recallContext(snapshot({ recalls: [near] }), "Breville Smart Electric Kettle", NOW);
  assert.equal(a.asserted.length, 0, "a product-only match is below the bar");
  assert.ok(a.withheld.length > 0, "and it is reported as withheld rather than dropped");
  const serialised = JSON.stringify(a);
  assert.ok(!serialised.includes("R-2"), "the withheld record's ref must not travel");
  assert.ok(!serialised.includes("Generic Electric Kettle"), "nor its title");
});

test("the near misses are available, but only to a caller that asks for them by name", () => {
  const near = recall({ ref: "R-2", title: "Generic Electric Kettle Recalled Due to Burn Hazard", brand: "Nobody" });
  const q = quarantinedFor(snapshot({ recalls: [near] }), "Breville Smart Electric Kettle");
  assert.equal(q.length, 1);
  assert.equal(q[0]!.ref, "R-2");
  assert.match(q[0]!.reason, /below the 0\.7 bar/);
});

test("a withdrawn notice is neither asserted nor counted as doubt", () => {
  // The regulator retracted it. Reporting "1 record withheld" would invent a doubt that
  // does not exist, and asserting it would present a retracted notice as an active one.
  const snap = snapshot({ recalls: [{ ...KETTLE, provenance: prov("cpsc", "withdrawn") }] });
  const a = recallContext(snap, "Breville Smart Kettle", NOW);
  assert.equal(a.asserted.length, 0);
  assert.equal(a.withheld.length, 0);
});

test("no seller identity can reach a caller", () => {
  // The guarantee the whole project rests on, asserted at this boundary too rather than
  // inherited from the snapshot's. A new field on the answer would otherwise be a new
  // door.
  const a = recallContext(snapshot(), "Breville Smart Kettle", NOW);
  const serialised = JSON.stringify(a);
  for (const banned of ["seller", "sellerKey", "sellerName"]) {
    assert.ok(!serialised.toLowerCase().includes(banned.toLowerCase()), `${banned} reached the answer`);
  }
});

test("vouchReport says whether absence is reportable at all", () => {
  assert.equal(vouchReport(snapshot(), NOW).canReportAbsence, true);
  assert.equal(vouchReport(unverifiedCpsc(), NOW).canReportAbsence, false);
  const kinds = vouchReport(snapshot(), NOW).sources.map((s) => `${s.id}:${s.kind}`);
  assert.deepEqual(kinds, ["cpsc:recall", "arcadia:recall"]);
});

test("a query too short to match anything is refused rather than answered emptily", () => {
  const a = recallContext(snapshot(), "ab", NOW);
  assert.notEqual(a.refusal, null);
  assert.equal(a.asserted.length, 0);
});

/** A source whose last cycle was refused at the door, still serving its last-good rows.
 *
 *  This state is reachable and it is the reason these tests exist. `deriveTrust` reads
 *  the rows a source is serving, and a blocked source serves the rows it read last time,
 *  which satisfy the contract because they are the same rows that satisfied it before.
 *  So trust stays `verified` and `contractPassed` stays true while the incident saying
 *  we were refused is still open. */
function blockedCpsc(): Snapshot {
  return snapshot({
    incidents: [
      {
        id: "I-blocked",
        sourceId: "cpsc",
        sourceLabel: "US CPSC",
        // After `lastVerifiedAt` (08:00), which is the only ordering the runner can
        // produce: a refused cycle goes through `carried()`, which never advances
        // `lastVerifiedAt`. A block dated before the last good cycle would describe a
        // source that was blocked and then successfully verified anyway, which is a
        // resolved incident wearing an open one's clothes.
        openedAt: "2026-08-19T09:00:00Z",
        closedAt: null,
        cause: "blocked",
        healable: false,
        evidence: ['listing returned HTTP 200 with block signature "checking your browser"'],
        refusal: "the source refused the request; healing cannot clear a block",
        healAttempted: false,
        healDeferred: false,
        healDurationMs: null,
        prompt: null,
        verified: false,
        mttrMs: null,
        withdrawnRefs: [],
        resurrectedRefs: [],
      },
    ] as never,
  });
}

test("an open block stops the service reporting absence, even while trust survives", () => {
  // The hole this closes. `unvouchedSources` read `trust` alone, and a blocked source
  // keeps `verified` trust because the rows it is still serving are the last ones that
  // passed. So the feed's own breakage report said the source was unhealthy while the
  // context service went on licensing "no recall matched" from it, which is precisely
  // the claim a stale source may not make. Presence survives a block; absence does not.
  const a = recallContext(blockedCpsc(), "Some Product Nobody Recalled", NOW);
  assert.equal(a.refusalCode, "absence_unverifiable");
  assert.match(a.refusal ?? "", /US CPSC/);
});

test("breakage health and the licence to report absence cannot disagree", () => {
  // These were computed two different ways: `healthy` looked at open incidents and
  // `canReportAbsence` looked at trust. One report contradicting itself in the same
  // object is worse than either answer alone, because a caller reading the reassuring
  // field has no reason to look at the other one.
  const b = breakageReport(blockedCpsc(), NOW);
  assert.equal(b.healthy, false);
  assert.equal(b.canReportAbsence, false);
});

test("a withdrawal does not stop the service reporting absence", () => {
  // The other direction, and it has to keep working. A `gone` incident is the system
  // behaving correctly: the record was removed at source, we established it, we kept
  // the last-good copy and refused to heal. Nothing about that says we lost rows, so
  // treating it as breakage would make the service refuse every time a notice was
  // withdrawn, which is an ordinary event and not a failure.
  const withGone = snapshot({
    incidents: [
      { ...(blockedCpsc().incidents[0] as never as Record<string, unknown>), id: "I-gone", cause: "gone" },
    ] as never,
  });
  const a = recallContext(withGone, "Some Product Nobody Recalled", NOW);
  assert.equal(a.refusalCode, null);
  assert.equal(breakageReport(withGone, NOW).canReportAbsence, true);
});

test("a snapshot with no sources at all is not healthy", () => {
  // `every` on an empty list is true, so a build that lost every source reported perfect
  // health. The reassuring direction is the wrong one to be vacuous in: a caller reading
  // `healthy` has no reason to look further, and there was nothing there to look at.
  const b = breakageReport(snapshot({ sources: [] }), NOW);
  assert.equal(b.healthy, false);
  assert.equal(b.canReportAbsence, false);
});

test("a query of characters nobody can see is too short, not a miss", () => {
  // Three zero-width spaces have length 3 and survive `trim`, so this cleared the
  // minimum-length gate and came back as a vouched NONE: we looked, we found nothing.
  // We did not look for anything. The same characters are stripped out of page text for
  // the same reason, that a character rendering as nothing is not part of what was said.
  const a = recallContext(snapshot(), "​​​", NOW);
  assert.equal(a.refusalCode, "query_too_short");
  assert.equal(a.asserted.length, 0);
});

test("a duplicate source id cannot be vouched for by its healthy twin", () => {
  // `find` stops at the first row with a matching id, so a snapshot carrying the same
  // source twice was judged on whichever copy came first. Presence is the claim that
  // costs something here: one row saying a source is fine does not answer for another
  // row saying it is not.
  const twice = snapshot({
    sources: [
      source("cpsc", "verified"),
      source("cpsc", "unverified", { contractPassed: false, breaches: ["row count fell 33.3%"] }),
      source("arcadia", "verified"),
    ],
  });
  const a = recallContext(twice, "Some Product Nobody Recalled", NOW);
  assert.equal(a.refusalCode, "absence_unverifiable");
});

// --- what "measured" means in a retry wait --------------------------------

/** An incident carrying only the fields `measuredRepairMs` reads. */
function inc(over: Partial<PubIncident>): PubIncident {
  return {
    id: "i", sourceId: "tradewell", sourceLabel: "Tradewell", openedAt: "2026-08-18T08:00:00.000Z",
    closedAt: "2026-08-18T08:06:00.000Z", cause: "drift", healable: true, evidence: [],
    refusal: null, healAttempted: true, healDeferred: false, healDurationMs: 1000,
    prompt: null, verified: true, mttrMs: null, withdrawnRefs: [], resurrectedRefs: [],
    rows: 12, breaches: [],
    ...over,
  } as PubIncident;
}

test("a withdrawal and a resurrection are not repairs, so they do not set the retry wait", () => {
  // The exact shape in runs/ as of 2026-08-20: a gone incident and a resurrected one
  // both carry verified=true and mttrMs=0, because nothing had to be repaired for them
  // to resolve. Median of [0, 0, 347580] is 0, so breakage_report told callers to retry
  // after 0s, on a source the engine elsewhere says to leave alone. The tool promises a
  // wait "measured from repairs that actually ran there", and two of those three are
  // events, not repairs.
  const incidents = [
    inc({ cause: "gone", mttrMs: 0 }),
    inc({ cause: "resurrected", mttrMs: 0 }),
    inc({ cause: "pagination", mttrMs: 347580 }),
  ];

  assert.equal(measuredRepairMs(incidents, "tradewell"), 347580);
});

test("a source whose only incidents were events has measured nothing", () => {
  // Null rather than zero. Nothing was measured, and saying "retry immediately" on the
  // strength of a withdrawal resolving instantly is a guess wearing a measurement.
  const incidents = [inc({ cause: "gone", mttrMs: 0 }), inc({ cause: "resurrected", mttrMs: 0 })];

  assert.equal(measuredRepairMs(incidents, "tradewell"), null);
});

test("an unverified repair does not count toward the wait", () => {
  const incidents = [
    inc({ cause: "drift", verified: false, mttrMs: 999 }),
    inc({ cause: "drift", mttrMs: 200000 }),
  ];

  assert.equal(measuredRepairMs(incidents, "tradewell"), 200000);
});

test("an event that took real time to resolve is still not a repair", () => {
  // Why the cause filter exists on top of the `> 0` guard, which would be enough today.
  // `gone` and `resurrected` both hardcode mttrMs to 0 right now, so zero alone catches
  // them. That is an implementation choice and a reasonable person could change it:
  // "time from noticing the withdrawal to serving without it" is a sensible thing to
  // record, and the moment it is recorded the median is poisoned again by a number that
  // has nothing to do with how long a repair takes. The filter is on what happened, not
  // on what it happened to measure.
  const incidents = [
    inc({ cause: "gone", mttrMs: 4000 }),
    inc({ cause: "resurrected", mttrMs: 5000 }),
    inc({ cause: "drift", mttrMs: 300000 }),
  ];

  assert.equal(measuredRepairMs(incidents, "tradewell"), 300000);
});

// --- an unclosed incident is not the same as a broken source ----------------

test("a deferred repair does not keep claiming work is in progress forever", () => {
  // Incidents are written once, at diagnosis, and nothing revisits them. A repair
  // deferred because another was already running on the collector therefore leaves a
  // record open permanently. breakage_report read that as the present tense and told
  // callers "the work is in progress" a day after the source had gone green, while
  // vouch_report called the same source healthy in the same breath.
  const snap = snapshot({
    incidents: [
      {
        id: "I-deferred", sourceId: "cpsc", sourceLabel: "US CPSC",
        openedAt: "2026-08-19T06:00:00Z", closedAt: null, cause: "pagination",
        healable: true, evidence: ["returned 7 rows against a baseline of 14"],
        refusal: null, healAttempted: false, healDeferred: true, healDurationMs: null,
        prompt: null, verified: false, mttrMs: null, withdrawnRefs: [], resurrectedRefs: [],
      },
    ] as never,
  });

  // The source was verified at 08:00, two hours after this opened.
  const b = breakageReport(snap, NOW);
  const cpsc = b.sources.find((s) => s.id === "cpsc");
  assert.equal(cpsc?.cause, null, "a source verified since is not still broken");
  assert.equal(b.canReportAbsence, true);
  assert.equal(b.healthy, true);
});

test("an incident opened after the last good cycle is still the present tense", () => {
  // The direction that must not loosen. Superseding on a later verification is only
  // sound because a refused cycle cannot advance `lastVerifiedAt`; if this ever starts
  // reading `null`, a live block stops refusing absence, which is the hole the open-
  // incident check was added to close in the first place.
  const b = breakageReport(blockedCpsc(), NOW);
  assert.equal(b.sources.find((s) => s.id === "cpsc")?.cause, "blocked");
  assert.equal(b.healthy, false);
  assert.equal(b.canReportAbsence, false);
});

test("a source that has never been verified keeps its incident open", () => {
  const snap = snapshot({
    sources: [
      source("cpsc", "verified", { lastVerifiedAt: null }),
      source("arcadia", "verified"),
    ],
    incidents: [
      {
        id: "I-first", sourceId: "cpsc", sourceLabel: "US CPSC",
        openedAt: "2026-08-19T06:00:00Z", closedAt: null, cause: "drift",
        healable: true, evidence: ["field title null rate 100.0%"], refusal: null,
        healAttempted: false, healDeferred: false, healDurationMs: null, prompt: null,
        verified: false, mttrMs: null, withdrawnRefs: [], resurrectedRefs: [],
      },
    ] as never,
  });

  assert.equal(breakageReport(snap, NOW).sources.find((s) => s.id === "cpsc")?.cause, "drift");
});

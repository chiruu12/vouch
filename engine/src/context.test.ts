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
import { recallContext, quarantinedFor, vouchReport } from "./context.js";
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

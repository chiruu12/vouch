// What changes when a second marketplace is real.
//
// Every listing in this feed used to come from Tradewell, a site we built. One source
// means a whole class of mistake is unreachable: there is no other provenance to attach
// by accident, no other id space to collide with, and no other incident log to pair a
// withdrawal against. "Everything here is a synthetic fixture" was true by construction
// and nothing had to enforce it.
//
// eBay is real, and now the label is doing work. A listing wearing the wrong provenance
// presents somebody's actual eBay listing as a fixture we invented, or presents a fixture
// as a real listing of a recalled product. Neither is a crash and neither is visible in a
// green suite unless something asks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSnapshot,
  pairResurrections,
  resurrectionKey,
  vouchedListings,
  type PubIncident,
  type PubListing,
} from "./snapshot.js";
import type { SourceState } from "./runner.js";
import type { Listing } from "./match.js";
import { supervisedTrust } from "./trust.js";
import { EBAY_CONTRACT } from "./sources/ebay.js";

/** The eBay state exactly as the snapshot builder reads it, or null when there is none. */
function readEbayState(): SourceState | null {
  try {
    return JSON.parse(readFileSync("../runs/state-ebay.json", "utf8")) as SourceState;
  } catch {
    return null;
  }
}

const snap = buildSnapshot(new Date("2026-08-20T00:00:00.000Z"));

/** Every listing the feed publishes, asserted and quarantined alike. */
function published(): PubListing[] {
  return snap.recalls.flatMap((r) => [...r.onSale, ...r.quarantined]);
}

/** A state file with only the fields these tests read. */
function state(over: Partial<SourceState>): SourceState {
  return {
    baselineRefs: [], baselineRows: null, lastVerifiedAt: null, lastGoodRows: [],
    healHistory: [], withdrawnRefs: [], streak: null, cooldownUntil: null,
    ...over,
  } as unknown as SourceState;
}

/** A listing shaped like a real one, because `ebay@1` has minimum lengths on id,
 *  permalink, title, currency, condition and location. Rows that fail the contract for
 *  incidental reasons would make every trust assertion below true for the wrong one. */
const listing = (id: string): Listing => ({
  id,
  permalink: `https://www.ebay.com/itm/${id}`,
  title: `Mini Fridge ${id} for Bedroom, Car, Office Desk and Dorm Room, Portable 6 Can Cooler`,
  brand: null,
  price: 103.71,
  currency: "USD",
  condition: "New",
  location: "Dallas, Texas, United States",
  listedOn: null,
});

/** Six ids the length `ebay@1` requires. */
const IDS = ["389993885441", "389993885442", "389993885443", "389993885444", "389993885445", "389993885446"];

test("both marketplaces are under supervision, and exactly one of them is ours", () => {
  // The floor under this file. Two marketplace cards, one synthetic and one not: if the
  // real one ever stops being registered, every rule below is a statement about a set
  // that only ever had fixtures in it.
  const tw = snap.sources.find((s) => s.id === "tradewell");
  const ebay = snap.sources.find((s) => s.id === "ebay");
  assert.ok(tw, "Tradewell is not a supervised source");
  assert.ok(ebay, "eBay is not a supervised source, so no real marketplace is on the cycle");
  assert.equal(tw.synthetic, true);
  assert.equal(ebay.synthetic, false);
});

test("a marketplace contributes only rows a cycle vouched for", () => {
  // The rule that replaced a capture fallback, and the one most likely to be helpfully
  // put back by someone who reads an empty marketplace as a bug.
  //
  // A recall source falls back to a committed capture because a feed with no recall
  // catalogue is not a feed. A marketplace does not, because an empty marketplace is a
  // perfectly good feed and a stale capture is 193 actionable claims about real sellers'
  // pages. `unverified` on the card is the honest report; publishing the capture anyway
  // and labelling it is the CPSC mistake in a new place.
  assert.deepEqual(vouchedListings(null), [], "a source with no state contributed listings");
  assert.deepEqual(
    vouchedListings(state({ lastGoodRows: [] as never })),
    [],
    "a source whose last cycle vouched for nothing fell back to something"
  );

  const rows = IDS.slice(0, 3).map(listing);
  assert.deepEqual(
    vouchedListings(state({ lastGoodRows: rows as never })).map((l) => l.id),
    IDS.slice(0, 3)
  );
});

test("a confirmed withdrawal never reaches the publish boundary", () => {
  const rows = IDS.slice(0, 3).map(listing);
  const out = vouchedListings(state({ lastGoodRows: rows as never, withdrawnRefs: [IDS[1]!] }));
  assert.deepEqual(
    out.map((l) => l.id),
    [IDS[0], IDS[2]],
    "a record proved withdrawn was published anyway"
  );
});

test("a listing's label is checked against the host it actually came from", () => {
  // Not against the card its own provenance names. That comparison is self-consistent by
  // construction: a Tradewell listing handed eBay's provenance reports eBay's synthetic
  // flag and eBay's label, agrees with eBay's card, and passes. It did pass, while every
  // published listing was a Tradewell fixture wearing eBay's provenance.
  //
  // The permalink is the one field on a published listing that does not come from the
  // provenance, so it is the only independent handle on which marketplace a listing is
  // really from. Matching its host against the source cards is what makes this a check
  // rather than a restatement.
  const all = published();
  assert.ok(all.length > 0, "nothing is published, so this rule proved nothing");
  const byHost = new Map(snap.sources.map((s2) => [new URL(s2.url).origin, s2]));

  let checked = 0;
  for (const l of all) {
    if (l.permalink === null) continue;
    const actual = byHost.get(new URL(l.permalink).origin);
    assert.ok(actual, `${l.id} links to ${new URL(l.permalink).origin}, which is no source we supervise`);
    checked++;
    assert.equal(
      l.provenance.sourceId,
      actual.id,
      `a listing hosted on ${actual.id} was published as coming from ${l.provenance.sourceId}`
    );
    assert.equal(l.provenance.synthetic, actual.synthetic);
    assert.equal(l.provenance.sourceLabel, actual.label);
  }
  assert.ok(checked > 0, "no published listing carried a permalink, so nothing was checked");
});

test("a published listing keeps the permalink it came in with", () => {
  // Not "is the permalink on the right host". That one cannot fail: `publishListing`
  // runs every permalink through `samePlaceWeScraped`, which returns null for anything
  // off-origin, so asserting the survivors are on-origin asserts the output of the
  // filter against the filter. It passes with or without the guarantee behind it.
  //
  // What CAN fail is the other side of that same filter. Both marketplaces publish
  // listings whose permalinks sit on their own source's host, so every published listing
  // should keep one. A listing handed the wrong marketplace's provenance gets compared
  // against the wrong source url, fails the origin check, and arrives here with its
  // permalink silently set to null. So a null is the symptom, and this is the assertion
  // that sees it.
  const all = published();
  assert.ok(all.length > 0, "nothing is published, so this rule proved nothing");
  const stripped = all.filter((l) => l.permalink === null);
  assert.deepEqual(
    stripped.map((l) => `${l.provenance.sourceId}:${l.id}`),
    [],
    "a published listing lost its permalink, which is what a mismatched provenance looks like"
  );
});

test("no seller identity survives into the published feed", () => {
  // Values, not field names, and taken from the raw capture rather than the snapshot.
  // The published type has no seller field, so searching the snapshot for one finds
  // nothing and reports a confident zero. The capture is where the identities are, and
  // it is what a leak would be leaking.
  const capture = readFileSync("samples/ebay-cooluli-minifridge.json", "utf8");
  const keys = new Set(capture.match(/sk_[0-9a-f]{6,}/g) ?? []);
  assert.ok(keys.size > 0, "no seller keys in the capture, so this test would search for nothing");

  const serialised = JSON.stringify(snap);
  assert.ok(!/sellerKey/i.test(serialised), "the snapshot carries a seller field name");
  // The pattern, not only the keys this one capture happens to hold. Those keys came
  // from a file that no longer feeds the published path at all, so checking for them and
  // nothing else would search the feed for identities that could not be in it. Live
  // eBay rows carry their own hashes, and the shape is what catches those.
  const leaked = serialised.match(/sk_[0-9a-f]{6,}/g) ?? [];
  assert.deepEqual([...new Set(leaked)], [], "the snapshot carries seller keys");
  for (const k of keys) {
    assert.ok(!serialised.includes(k), `the snapshot carries seller key ${k}`);
  }
});

test("a withdrawal on one source cannot explain a return on another", () => {
  const inc = (over: Partial<PubIncident>): PubIncident =>
    ({
      id: "i", sourceId: "tradewell", sourceLabel: "l", openedAt: "2026-08-01T00:00:00.000Z",
      closedAt: null, cause: "gone", healable: false, evidence: [], refusal: null,
      healAttempted: false, healDeferred: false, healDurationMs: null, prompt: null,
      verified: true, mttrMs: null, withdrawnRefs: [], resurrectedRefs: [], rows: 1, breaches: [],
      ...over,
    }) as PubIncident;

  const crossed = pairResurrections([
    inc({ sourceId: "tradewell", withdrawnRefs: ["7"], openedAt: "2026-08-01T00:00:00.000Z" }),
    inc({ sourceId: "ebay", resurrectedRefs: ["7"], openedAt: "2026-08-02T00:00:00.000Z" }),
  ]);
  assert.equal(crossed.size, 0, "a Tradewell withdrawal was accepted as the missing half of an eBay return");

  const same = pairResurrections([
    inc({ sourceId: "ebay", withdrawnRefs: ["7"], openedAt: "2026-08-01T00:00:00.000Z" }),
    inc({ sourceId: "ebay", resurrectedRefs: ["7"], openedAt: "2026-08-02T00:00:00.000Z" }),
  ]);
  assert.deepEqual(same.get(resurrectionKey("ebay", "7")), {
    withdrawnAt: "2026-08-01T00:00:00.000Z",
    backOnSaleAt: "2026-08-02T00:00:00.000Z",
  });

  // And a return with nothing behind it stays unpublished rather than being guessed at.
  assert.equal(pairResurrections([inc({ sourceId: "ebay", resurrectedRefs: ["9"] })]).size, 0);
});

test("a source with no cycle behind it is unverified, however clean its rows are", () => {
  // Direct, because the version of this that read the published card was conditional:
  // it only asserted when the source had rows, eBay had none, and so the assertion never
  // ran at all. A check that skips itself is worse than no check, because it reports a
  // pass.
  //
  // The rows below satisfy `ebay@1` on purpose. Without that, `unverified` would be the
  // answer for the ordinary reason that the contract failed, and the rule being tested
  // here, that supervision and not parseability decides trust, would be proved by
  // nothing. `verified` in the third case is what shows the rows really do pass.
  const rows = IDS.map(listing);

  assert.equal(supervisedTrust(EBAY_CONTRACT, null, rows), "unverified", "a source with no state file was trusted");
  assert.equal(
    supervisedTrust(EBAY_CONTRACT, state({ lastGoodRows: [] as never }), rows),
    "unverified",
    "a source whose last cycle vouched for nothing was trusted"
  );
  assert.equal(
    supervisedTrust(EBAY_CONTRACT, state({ lastGoodRows: rows as never, baselineRows: rows.length }), rows),
    "verified",
    "these rows have to pass the contract, or the two assertions above prove nothing"
  );
});

test("a source that never passed a cycle says never, rather than dating a capture", () => {
  // `capturedAt` exists so a source served from a committed capture can state when that
  // capture was taken instead of reporting "last verified never", which would be wrong
  // in the other direction. It only means that while the capture is what is being
  // served. A marketplace serves nothing it has not vouched for, so the moment a capture
  // was taken is a date attached to nothing, and putting it on the card is the sentence
  // "last verified 17 August" under a source whose every cycle has failed.
  const card = snap.sources.find((s2) => s2.id === "ebay");
  assert.ok(card, "eBay has no source card");
  const st = readEbayState();
  assert.equal(
    card.lastVerifiedAt,
    st?.lastVerifiedAt ?? null,
    "the card is dating something other than a cycle that passed"
  );
});

test("the real marketplace card never claims a verification that did not happen", () => {
  const card = snap.sources.find((s) => s.id === "ebay");
  assert.ok(card, "eBay has no source card");
  assert.equal(card.synthetic, false);
  // Deliberately not asserting `lastVerifiedAt !== null` here. That rule protects a
  // published RECORD, whose age a reader has to be able to state, and it is enforced in
  // `provenanceFor`. A source card with no records is the other case: "never" is the
  // honest thing for it to say, and the test above is the one that holds it to it.
  // The card is built by `sourceCard`, which re-derives trust independently. It has
  // disagreed with the per-record provenance before: the feed labelled every record
  // verified while its own health strip called the source unverified, two true sentences
  // with one word doing both jobs. This is the assertion that would have caught it.
  const st = readEbayState();
  assert.equal(card.rows, vouchedListings(st).length, "the card counts rows the feed does not have");
  assert.equal(
    card.trust,
    supervisedTrust(EBAY_CONTRACT, st, vouchedListings(st)),
    "the health strip and the rule disagree about eBay"
  );
});

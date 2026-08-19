// What the evolver may learn, and what it must only ever propose.
//
// The interesting tests here are again the refusals. A learner that finds nothing is
// useless; one that applies the wrong thing unattended is worse than useless, because
// the failure is silent and shaped exactly like success.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mayApplyUnattended, partition } from "./policy.js";
import type { Change } from "./change.js";
import { changeKey } from "./change.js";
import {
  candidatePhrases,
  emptyLedger,
  observePage,
  proposeMarkers,
  visibleText,
} from "./gone-markers.js";
import { carriesObservedMarkup, proposeStrategies, splitByMarkup } from "./heal-strategy.js";
import type { PhraseLedger } from "./gone-markers.js";
import {
  BUILTIN_MARKERS,
  acceptMarker,
  activeMarkers,
  disprovedMarkers,
  emptyMarkerStore,
  retract,
  type MarkerStore,
} from "./markers.js";

const alias: Change = {
  kind: "alias",
  source: "tradewell",
  canonical: "id",
  raw: "listing_id",
  what: "read listing_id as id",
  evidence: "id was null on all 12 rows",
};

const marker: Change = {
  kind: "gone-marker",
  source: "ebay",
  marker: "this listing was ended by the seller",
  goneRefs: 4,
  liveRefs: 0,
  what: "treat it as a withdrawal phrase",
  evidence: "4 gone, 0 live",
};

const strategy: Change = {
  kind: "heal-strategy",
  cause: "drift",
  prefer: "prompt without observed markup",
  over: "prompt carrying observed hooks and labels",
  what: "prefer the narrower prompt",
  evidence: "3/4 versus 1/4",
};

describe("what may be applied with nobody watching", () => {
  it("applies an alias, because it can only fill a null and is undone by deleting a name", () => {
    assert.equal(mayApplyUnattended(alias).unattended, true);
  });

  it("never applies a withdrawal phrase, however good the evidence looks", () => {
    // The evidence on this one is as strong as the ledger can make it: four distinct
    // gone records, nothing live. It still waits for a person, because the error it
    // would cause runs in the direction that takes live safety recalls off the feed.
    assert.equal(mayApplyUnattended(marker).unattended, false);
    assert.match(mayApplyUnattended(marker).because, /removes live recalls/);
  });

  it("never applies a repair-prompt change, because a wedged collector does not come back", () => {
    assert.equal(mayApplyUnattended(strategy).unattended, false);
    assert.match(mayApplyUnattended(strategy).because, /wedge/);
  });

  it("sorts a mixed batch into the two lanes", () => {
    const { auto, proposed } = partition([alias, marker, strategy]);
    assert.deepEqual(auto.map((c) => c.kind), ["alias"]);
    assert.deepEqual(proposed.map((c) => c.kind), ["gone-marker", "heal-strategy"]);
  });

  it("gives each kind of change a distinct key", () => {
    const keys = new Set([alias, marker, strategy].map(changeKey));
    assert.equal(keys.size, 3);
  });
});

describe("mining a page for withdrawal phrases", () => {
  const GONE = `
    <html><head><style>.x{color:red}</style><script>var seller="alice-bargain-barn";</script></head>
    <body><h1>Bloom Fridge 4L</h1>
    <p>This listing was ended by the seller.</p>
    <p>Sold by alice-bargain-barn</p>
    <span>Item number 306847319423</span>
    </body></html>`;

  it("reads what a person would see, not the page's own script payload", () => {
    const text = visibleText(GONE);
    assert.equal(text.includes("alice-bargain-barn"), true, "the visible byline is still visible");
    assert.equal(/var seller/.test(text), false, "the script contents are not text");
  });

  it("takes short standalone messages as candidates", () => {
    assert.equal(candidatePhrases(GONE).includes("this listing was ended by the seller"), true);
  });

  it("drops anything carrying digits, which is where identifiers and prices live", () => {
    assert.equal(
      candidatePhrases(GONE).some((p) => /\d/.test(p)),
      false
    );
  });

  it("drops a phrase too short to be a message", () => {
    assert.equal(candidatePhrases("<p>ended</p><p>ok then</p>").length, 0);
  });
});

describe("proposing a withdrawal phrase", () => {
  const ENDED = "<p>This listing was ended by the seller.</p>";
  const LIVE = "<p>This listing was ended by the seller.</p><p>Buy it now and save</p>";

  it("offers a phrase seen on two distinct gone records and never on a live one", () => {
    let l = emptyLedger();
    l = observePage(l, "ebay", "A1", ENDED, "gone");
    l = observePage(l, "ebay", "A2", ENDED, "gone");
    const found = proposeMarkers(l, () => []);
    assert.equal(found[0]?.marker, "this listing was ended by the seller");
    assert.equal(found[0]?.goneRefs, 2);
  });

  it("refuses a phrase seen on only one gone record", () => {
    // One page's own wording and a site's removal notice look identical from one page.
    // This is also what keeps a seller's name out: a name appears on their listing, not
    // on two unrelated withdrawn records.
    let l = emptyLedger();
    l = observePage(l, "ebay", "A1", ENDED, "gone");
    assert.deepEqual(proposeMarkers(l, () => []), []);
  });

  it("refuses a phrase that also appears on a record proved live", () => {
    let l = emptyLedger();
    l = observePage(l, "ebay", "A1", ENDED, "gone");
    l = observePage(l, "ebay", "A2", ENDED, "gone");
    l = observePage(l, "ebay", "B1", LIVE, "live");
    assert.deepEqual(
      proposeMarkers(l, () => []).map((c) => c.marker),
      [],
      "one live sighting disqualifies it, whatever the gone count"
    );
  });

  it("does not re-offer a phrase the oracle already looks for", () => {
    let l = emptyLedger();
    l = observePage(l, "ebay", "A1", ENDED, "gone");
    l = observePage(l, "ebay", "A2", ENDED, "gone");
    assert.deepEqual(proposeMarkers(l, () => ["ended by the seller"]), []);
  });

  it("never writes a page down, only phrases and which records carried them", () => {
    // The guarantee that makes this safe to run against a real marketplace: there is no
    // body on disk to leak, so the ledger cannot become a second copy of seller data.
    let l = emptyLedger();
    l = observePage(l, "ebay", "A1", ENDED, "gone");
    const serialised = JSON.stringify(l);
    assert.equal(serialised.includes("<p>"), false, "no markup is retained");
    assert.equal(serialised.includes("Buy it now"), false);
    for (const rec of Object.values(l.sources.ebay ?? {})) {
      assert.deepEqual(rec.goneRefs, ["A1"]);
    }
  });

  it("counts a record once however many times it is probed", () => {
    let l = emptyLedger();
    l = observePage(l, "ebay", "A1", ENDED, "gone");
    l = observePage(l, "ebay", "A1", ENDED, "gone");
    l = observePage(l, "ebay", "A2", ENDED, "gone");
    assert.equal(proposeMarkers(l, () => [])[0]?.goneRefs, 2, "two records, not three probes");
  });

  it("does not mutate the ledger it was given", () => {
    const first = emptyLedger();
    const snapshot = JSON.stringify(first);
    observePage(first, "ebay", "A1", ENDED, "gone");
    assert.equal(JSON.stringify(first), snapshot);
  });
});

describe("measuring whether the scraped half of a repair prompt earns its place", () => {
  const withMarkup = (verified: boolean) => ({
    cause: "drift",
    prompt: "Fix it. Attribute hooks present in the live document: data-x, data-y.",
    verified,
  });
  const without = (verified: boolean) => ({
    cause: "drift",
    prompt: "The previously working selector .title now matches 0 elements.",
    verified,
  });

  it("recognises the clauses copied out of the scraped page", () => {
    assert.equal(carriesObservedMarkup(withMarkup(true).prompt), true);
    assert.equal(carriesObservedMarkup(without(true).prompt), false);
  });

  it("ignores a refused cause, which has no prompt to compare", () => {
    const split = splitByMarkup([{ cause: "gone", prompt: null, verified: false }]);
    assert.deepEqual(split, []);
  });

  it("declines to compare on too little evidence, and says so", () => {
    const found = proposeStrategies([withMarkup(true), without(false)]);
    assert.equal(found[0]?.prefer, "no change");
    assert.match(found[0]?.evidence ?? "", /not enough measured repairs/);
  });

  it("argues for dropping the scraped clause when it does not pay for itself", () => {
    const found = proposeStrategies([
      withMarkup(false),
      withMarkup(false),
      without(true),
      without(true),
    ]);
    assert.equal(found[0]?.prefer, "prompt without observed markup");
    assert.match(found[0]?.evidence ?? "", /not paying for itself/);
  });

  it("argues for keeping it when the repairs carrying it verify better", () => {
    const found = proposeStrategies([
      withMarkup(true),
      withMarkup(true),
      without(false),
      without(false),
    ]);
    assert.equal(found[0]?.prefer, "prompt carrying observed hooks and labels");
    assert.match(found[0]?.evidence ?? "", /earns its place/);
  });

  it("prefers the narrower prompt when the two are tied", () => {
    // A tie is not a reason to keep the larger attack surface.
    const found = proposeStrategies([withMarkup(true), withMarkup(false), without(true), without(false)]);
    assert.equal(found[0]?.prefer, "prompt without observed markup");
  });
});

// Adding a withdrawal phrase and taking one back.
//
// These two directions are deliberately not symmetric, and that asymmetry is the whole
// argument for letting any of this run unattended. Adding a phrase can remove live
// safety recalls from the feed, so it needs a person. Removing one can at worst leave a
// withdrawn record showing until somebody notices, which the rest of the system already
// handles. So the supervisor may narrow its own oracle on evidence, and never widen it.
describe("the withdrawal phrases the oracle looks for", () => {
  const CAND = {
    marker: "this listing was ended by the seller",
    source: "ebay",
    goneRefs: 4,
    evidence: "seen on 4 gone records, 0 live",
  };
  const NOW = "2026-08-19T00:00:00.000Z";

  const ledgerWith = (marker: string, gone: string[], live: string[]): PhraseLedger => ({
    version: 1,
    sources: { ebay: { [marker]: { goneRefs: gone, liveRefs: live } } },
  });

  it("starts with the phrases a person wrote and nothing else", () => {
    assert.deepEqual([...activeMarkers("ebay", emptyMarkerStore())], [...BUILTIN_MARKERS]);
  });

  it("looks for a phrase once it has been accepted", () => {
    const store = acceptMarker(emptyMarkerStore(), CAND, NOW);
    assert.equal(activeMarkers("ebay", store).includes(CAND.marker), true);
  });

  it("does not duplicate a phrase, or re-add one already built in", () => {
    const once = acceptMarker(emptyMarkerStore(), CAND, NOW);
    const twice = acceptMarker(once, CAND, NOW);
    assert.equal(twice.learned.length, 1);
    const builtin = acceptMarker(emptyMarkerStore(), { ...CAND, marker: "listing ended" }, NOW);
    assert.deepEqual(builtin.learned, []);
  });

  it("retracts a learned phrase the moment one live page carries it", () => {
    // One counterexample, not a rate. The claim a marker makes is "a page saying this is
    // gone", so a single live page saying it is a disproof.
    const store = acceptMarker(emptyMarkerStore(), CAND, NOW);
    const found = disprovedMarkers(store, ledgerWith(CAND.marker, ["A1", "A2"], ["B7"]));
    assert.deepEqual(found, [{ marker: CAND.marker, source: "ebay", disprovedBy: "B7" }]);
    assert.ok(found[0] !== undefined);
    const after = retract(store, found[0], NOW);
    assert.equal(activeMarkers("ebay", after).includes(CAND.marker), false);
    assert.equal(after.retracted[0]?.disprovedBy, "B7", "the record that disproved it is recorded");
  });

  it("leaves a learned phrase alone while nothing contradicts it", () => {
    const store = acceptMarker(emptyMarkerStore(), CAND, NOW);
    assert.deepEqual(disprovedMarkers(store, ledgerWith(CAND.marker, ["A1", "A2"], [])), []);
  });

  it("never retracts a phrase a person wrote", () => {
    // The built-ins are the floor. A live page carrying one is a reason for a person to
    // look, not for the machine to quietly narrow the oracle below what was reviewed.
    const store = emptyMarkerStore();
    assert.deepEqual(disprovedMarkers(store, ledgerWith("listing ended", [], ["B7"])), []);
    assert.equal(activeMarkers("ebay", store).includes("listing ended"), true);
  });

  it("keeps a retraction even if the learned entry lingers", () => {
    const store: MarkerStore = {
      version: 1,
      learned: [{ marker: "x phrase", source: "ebay", acceptedAt: NOW, goneRefs: 2, evidence: "e" }],
      retracted: [{ marker: "x phrase", source: "ebay", retractedAt: NOW, disprovedBy: "B1" }],
    };
    assert.equal(activeMarkers("ebay", store).includes("x phrase"), false);
  });

  it("a phrase learned on one site is not an oracle on another", () => {
    // This was a real hole. The store recorded `source` on every learned marker and the
    // retraction logic already read the ledger per source, but the active set concatenated
    // every learned phrase regardless, so a phrase accepted from eBay's 404 chrome was a
    // withdrawal signal for a regulator's site. A false withdrawal removes a live safety
    // recall from the feed, which is the exact failure the accept/retract asymmetry was
    // built to prevent, arriving through the back door.
    const store = acceptMarker(emptyMarkerStore(), CAND, NOW);
    assert.equal(activeMarkers("ebay", store).includes(CAND.marker), true);
    assert.equal(activeMarkers("arcadia", store).includes(CAND.marker), false);
    // The floor a person wrote is still everywhere.
    assert.equal(activeMarkers("arcadia", store).includes("listing ended"), true);
  });

  it("one site disproving a phrase does not retract it on another", () => {
    const both: MarkerStore = {
      version: 1,
      learned: [
        { marker: "gone for good", source: "ebay", acceptedAt: NOW, goneRefs: 2, evidence: "e" },
        { marker: "gone for good", source: "arcadia", acceptedAt: NOW, goneRefs: 2, evidence: "e" },
      ],
      retracted: [],
    };
    const after = retract(both, { marker: "gone for good", source: "ebay", disprovedBy: "B7" }, NOW);
    // Two sites can independently use the same wording, and eBay showing it on a live page
    // says nothing about what it means on a regulator's site.
    assert.equal(activeMarkers("ebay", after).includes("gone for good"), false);
    assert.equal(activeMarkers("arcadia", after).includes("gone for good"), true);
  });

  it("lets a person overrule a retraction by accepting again", () => {
    const retracted: MarkerStore = {
      version: 1,
      learned: [],
      retracted: [{ marker: CAND.marker, source: "ebay", retractedAt: NOW, disprovedBy: "B1" }],
    };
    const after = acceptMarker(retracted, CAND, NOW);
    assert.equal(activeMarkers("ebay", after).includes(CAND.marker), true);
  });
});

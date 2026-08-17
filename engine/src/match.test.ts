// Matching tests, run against the real 193-row Cooluli capture.
//
// Every case here is a bug that actually happened while measuring the match rate on
// real data, in the order it happened:
//
//   1. matched on the token "liter", so every Cooluli fridge matched a 10L/15L recall
//   2. missed "mini fridge" because the notice says "Minifridges"
//   3. matched "10 FT POWER CABLE" on the bare number 10
//   4. matched power cords and a branded eye mask as if they were the fridge
//   5. missed "Cooluli Infinity Black 15 Liter fridge", a genuinely recalled unit
//
// 5 is the one that matters most. A false positive is visible and gets argued with; a
// recalled unit silently absent from the feed looks like a clean result.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchListings, scoreMatch, PUBLISH_THRESHOLD, type Listing } from "./match.js";
import { normaliseCpsc } from "./sources/cpsc.js";
import { normaliseEbay } from "./sources/ebay.js";
import type { RecallRecord } from "./types.js";

function asRecall(c: Omit<RecallRecord, "provenance">): RecallRecord {
  return {
    ...c,
    provenance: {
      sourceId: "cpsc",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      contractVersion: "cpsc@1",
      state: "verified",
      lastVerifiedAt: "2026-08-17T00:00:00.000Z",
      healHistory: [],
    },
  };
}

const recalls = normaliseCpsc(
  JSON.parse(readFileSync(new URL("../test/fixtures/cpsc-sample.json", import.meta.url), "utf8"))
).map(asRecall);

function recall(ref: string): RecallRecord {
  const r = recalls.find((x) => x.ref === ref);
  assert.ok(r, `no recall ${ref}`);
  return r;
}

/** 10-Liter and 15-Liter Cooluli Minifridges. */
const COOLULI = recall("26685");

const listings = normaliseEbay(
  JSON.parse(
    readFileSync(new URL("../samples/ebay-cooluli-minifridge.json", import.meta.url), "utf8")
  )
);

function listing(overrides: Partial<Listing> & { title: string }): Listing {
  return {
    id: "1",
    permalink: "https://www.ebay.com/itm/1",
    brand: null,
    price: 100,
    currency: "USD",
    condition: "Used",
    location: null,
    listedOn: null,
    ...overrides,
  };
}

describe("matching against the real Cooluli capture", () => {
  const matches = matchListings([COOLULI], listings);

  it("publishes the 15 Liter unit, which the recall actually covers", () => {
    const target = listings.find((l) => /Infinity Black 15 Liter/i.test(l.title));
    assert.ok(target, "the 15 Liter listing is missing from the sample");
    const m = matches.find((x) => x.listingId === target.id);
    assert.ok(m, "the 15 Liter Cooluli fridge produced no match at all");
    assert.equal(m.contradiction, null);
    assert.equal(m.publishable, true);
    assert.ok(m.confidence >= PUBLISH_THRESHOLD);
  });

  it("quarantines every capacity the recall does not cover", () => {
    const clashes = matches.filter((m) => m.contradiction?.startsWith("recall covers"));
    assert.ok(clashes.length > 50, `expected many capacity clashes, got ${clashes.length}`);
    for (const m of clashes) {
      assert.equal(m.publishable, false, "a contradicted match must never publish");
      assert.ok(m.confidence < PUBLISH_THRESHOLD);
    }
  });

  it("quarantines power cords and adapters as accessories", () => {
    const cords = listings.filter((l) => /power cord|ac adapter|power cable/i.test(l.title));
    assert.ok(cords.length > 5, "sample should contain several accessory listings");
    for (const l of cords) {
      const m = matches.find((x) => x.listingId === l.id);
      if (m === undefined) continue; // never matching at all is also acceptable
      assert.equal(m.publishable, false, `accessory published: ${l.title}`);
    }
  });

  it("does not quarantine a fridge described as Plug In", () => {
    // "plug" was in the accessory list and demoted the product itself.
    const target = listings.find((l) => /Plug In/i.test(l.title));
    if (target === undefined) return;
    const m = matches.find((x) => x.listingId === target.id);
    assert.ok(m);
    assert.equal(
      m.contradiction?.includes("accessory") ?? false,
      false,
      `product misread as accessory: ${target.title}`
    );
  });

  it("never matches on a unit of measure alone", () => {
    for (const m of matches) {
      assert.equal(
        m.matchedTokens.some((t) => ["liter", "liters", "litre", "litres"].includes(t)),
        false,
        `matched on a unit: ${m.matchedTokens.join(", ")}`
      );
    }
  });

  it("never matches on a bare number", () => {
    for (const m of matches) {
      for (const t of m.matchedTokens) {
        assert.equal(/^\d+$/.test(t), false, `matched on bare number "${t}"`);
      }
    }
  });
});

describe("compound decomposition", () => {
  it("matches the notice's Minifridges against a listing saying fridge", () => {
    const m = scoreMatch(COOLULI, listing({ title: "Cooluli Infinity Black 15 Liter fridge" }));
    assert.ok(m, "compound was not decomposed");
    assert.equal(m.publishable, true);
  });

  it("matches an open compound written as two words", () => {
    const m = scoreMatch(COOLULI, listing({ title: "BRAND NEW MINI FRIDGE- COOLULI" }));
    assert.ok(m);
    assert.equal(m.publishable, true);
  });

  it("does not let a dishwasher match a pressure washer recall", () => {
    // Decomposition runs one way only. The reverse would treat any longer compound
    // ending in "washer" as the recalled appliance.
    const washer = recall("26692"); // COMMOWNER Pressure Washers
    const m = scoreMatch(washer, listing({ title: "Bosch Dishwasher stainless steel built in" }));
    assert.equal(m?.publishable ?? false, false, `dishwasher matched a washer recall: ${JSON.stringify(m)}`);
  });
});

describe("contradiction reporting", () => {
  it("states the capacities on both sides so a reader can check it", () => {
    const m = scoreMatch(COOLULI, listing({ title: "Cooluli 20 Liter Mini Fridge White" }));
    assert.ok(m);
    assert.equal(m.publishable, false);
    assert.ok(m.contradiction?.includes("20"), m.contradiction ?? "no contradiction");
    assert.ok(m.contradiction?.includes("10"), m.contradiction ?? "no contradiction");
  });

  it("does not fire when the listing states a covered capacity", () => {
    const m = scoreMatch(COOLULI, listing({ title: "Cooluli 10 Liter Mini Fridge White" }));
    assert.ok(m);
    assert.equal(m.contradiction, null);
    assert.equal(m.publishable, true);
  });

  it("does not fire when the listing states no capacity at all", () => {
    // Absence of a capacity is not evidence against a match; it is just unknown.
    const m = scoreMatch(COOLULI, listing({ title: "Cooluli Mini Fridge for Bedroom" }));
    assert.ok(m);
    assert.equal(m.contradiction, null);
    assert.equal(m.publishable, true);
  });

  it("keeps a contradicted match rather than dropping it", () => {
    // Silently deleting near-misses would hide the system's own uncertainty.
    const m = scoreMatch(COOLULI, listing({ title: "Cooluli 4L Mini Fridge" }));
    assert.ok(m, "contradicted match was dropped instead of quarantined");
    assert.equal(m.publishable, false);
  });
});

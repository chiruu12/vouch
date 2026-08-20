// These run against the real 169-row eBay capture, not a hand-written fixture.
// The point of the last test is that the contract passes on data we actually
// received: a contract calibrated against imagination fails on healthy runs, and a
// check that fails on healthy runs gets ignored by the person reading it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkContract } from "../contract.js";
import {
  EBAY_CONTRACT,
  ebayRefOf,
  normaliseCondition,
  normaliseEbay,
  normaliseLocation,
} from "./ebay.js";

const sample: unknown = JSON.parse(
  readFileSync(new URL("../../samples/ebay-pressure-washer.json", import.meta.url), "utf8")
);

const frozenNow = () => new Date("2026-08-17T16:30:00.000Z");

describe("normaliseCondition", () => {
  it("collapses the doubled label and drops the tooltip tail", () => {
    assert.equal(normaliseCondition("New New More information - About this item condition"), "New");
    assert.equal(
      normaliseCondition("Used Used More information - About this item condition"),
      "Used"
    );
  });

  it("keeps a multi-word condition whole rather than cutting at the first word", () => {
    // Greedy-first matching would turn this into "Good", losing the qualifier that
    // distinguishes a refurbished unit from a working one.
    assert.equal(
      normaliseCondition(
        "Good - Refurbished Good - Refurbished More information - About this item condition"
      ),
      "Good - Refurbished"
    );
    assert.equal(
      normaliseCondition(
        "Certified - Refurbished Certified - Refurbished More information - About this item condition"
      ),
      "Certified - Refurbished"
    );
  });

  it("handles a localised row, where the English tail is absent", () => {
    assert.equal(
      normaliseCondition("Novo Novo Mais informações - sobre o estado deste item"),
      "Novo"
    );
  });

  it("passes through a value that is not doubled", () => {
    assert.equal(normaliseCondition("Open box"), "Open box");
  });

  it("returns null for blank input", () => {
    assert.equal(normaliseCondition(""), null);
    assert.equal(normaliseCondition("   "), null);
    assert.equal(normaliseCondition(null), null);
    assert.equal(normaliseCondition(undefined), null);
  });
});

describe("normaliseLocation", () => {
  it("strips the Located in prefix", () => {
    assert.equal(
      normaliseLocation("Located in: Ft Mill, SC, United States"),
      "Ft Mill, SC, United States"
    );
  });

  it("returns null when the field is missing", () => {
    assert.equal(normaliseLocation(undefined), null);
    assert.equal(normaliseLocation("Located in:"), null);
  });
});

describe("normaliseEbay", () => {
  it("normalises every row of the real capture", () => {
    const listings = normaliseEbay(sample);
    assert.equal(listings.length, 169);
    for (const l of listings) {
      assert.ok(l.id.length > 0, "id must be present");
      assert.ok(l.title.length > 0, "title must be present");
      assert.ok(l.permalink !== null, "permalink must be present");
    }
  });

  it("takes the numeric item id out of the permalink", () => {
    const listings = normaliseEbay(sample);
    const first = listings[0];
    assert.ok(first);
    assert.match(first.id, /^\d+$/);
    assert.ok(first.permalink?.includes(first.id));
  });

  it("prefers price.currency over the sibling site code", () => {
    // The raw rows carry currency: "US", which is not a currency. Trusting it would
    // put a country code in front of every price in the feed.
    const listings = normaliseEbay(sample);
    const currencies = new Set(listings.map((l) => l.currency));
    assert.ok(currencies.has("USD"), `expected USD, saw ${[...currencies].join(", ")}`);
    assert.equal(currencies.has("US"), false, "site code leaked into currency");
  });

  it("parses price to a finite number", () => {
    const listings = normaliseEbay(sample);
    for (const l of listings) {
      assert.equal(typeof l.price, "number");
      assert.equal(Number.isFinite(l.price), true);
    }
  });

  it("never carries a plain seller name through", () => {
    const listings = normaliseEbay(sample);
    for (const l of listings) {
      assert.equal("seller_name" in l, false);
      if (l.sellerKey !== undefined) assert.match(l.sellerKey, /^sk_[0-9a-f]{12}$/);
    }
  });

  it("hashes a live seller_name rather than passing it along", () => {
    const [listing] = normaliseEbay([
      {
        title: "Test pressure washer 3600 PSI",
        listing_url: "https://www.ebay.com/itm/123456789012",
        price: { value: 199.99, currency: "USD" },
        condition: "New New More information - About this item condition",
        location: "Located in: Reno, NV, United States",
        seller_name: "Some Real Seller",
      },
    ]);
    assert.ok(listing);
    assert.match(listing.sellerKey ?? "", /^sk_[0-9a-f]{12}$/);
    assert.equal(JSON.stringify(listing).includes("Some Real Seller"), false);
  });

  it("drops crawler error rows instead of counting them as listings", () => {
    const listings = normaliseEbay([
      { input: { url: "https://www.ebay.com/sch/i.html" }, error: "Crawler error", error_code: "rate_limit" },
      {
        title: "Real listing 3600 PSI washer",
        listing_url: "https://www.ebay.com/itm/999888777666",
        price: { value: 10, currency: "USD" },
      },
    ]);
    assert.equal(listings.length, 1);
  });

  it("drops a row with no usable permalink", () => {
    assert.deepEqual(normaliseEbay([{ title: "No url here at all" }]), []);
  });
});

describe("EBAY_CONTRACT", () => {
  it("passes on the real capture", () => {
    const listings = normaliseEbay(sample);
    const report = checkContract(EBAY_CONTRACT, listings, listings.length, frozenNow, ebayRefOf);
    assert.equal(
      report.passed,
      true,
      `contract failed on healthy real data: ${report.breaches.join("; ")}`
    );
  });

  it("names the offending listing id in breach evidence, not an empty string", () => {
    const broken = normaliseEbay(sample).map((l, i) => (i === 0 ? { ...l, condition: null } : l));
    const report = checkContract(
      { ...EBAY_CONTRACT, fields: { condition: { type: "string", maxNullRate: 0 } } },
      broken,
      broken.length,
      frozenNow,
      ebayRefOf
    );
    assert.equal(report.passed, false);
    const condition = report.fields.find((f) => f.field === "condition");
    assert.ok(condition);
    assert.equal(condition.sampleRefs.length, 1);
    assert.match(condition.sampleRefs[0] ?? "", /^\d+$/);
  });

  it("tolerates the location rate a deep crawl really has, and still catches the selector breaking", () => {
    // The limit was 5%, calibrated on the 169-row pressure-washer capture where 2 rows
    // lacked a location. The supervised query is a different search and the collector
    // crawls it about three times deeper, and eBay's tail is sparser than its first page:
    //
    //   pressure washer, 169 rows    2 null   1.2%   <- what the 5% limit was set against
    //   cooluli study,   193 rows    4 null   2.1%
    //   cooluli live,    559 rows   25 null   4.5%
    //   cooluli cycle,   568 rows            5.6%   <- breached, and a heal was attempted
    //
    // A repair cannot make a seller fill in a location, so that breach bought a refusal
    // and a wasted repair for a field behaving exactly as the adapter header says it
    // does. The limit was measuring the marketplace rather than our extraction.
    //
    // 10% is a little under twice the worst rate seen. What the check exists to catch is
    // the selector breaking, and that does not arrive as 6%: it arrives as 100%. Both
    // directions are asserted here so the number cannot be loosened until it stops
    // catching anything.
    // Built to a rate rather than to a stride, so the fixture cannot drift past the limit
    // it is meant to sit under when the capture behind it changes size.
    const rows = normaliseEbay(sample);
    const want = Math.round(rows.length * 0.07);
    let nulled = rows.filter((l) => l.location === null).length;
    const sparse = rows.map((l) => {
      if (l.location !== null && nulled < want) {
        nulled++;
        return { ...l, location: null };
      }
      return l;
    });
    const sparseRate = sparse.filter((l) => l.location === null).length / sparse.length;
    assert.ok(sparseRate > 0.05, `fixture is ${(sparseRate * 100).toFixed(1)}% null and has to exceed the old 5% limit`);
    assert.ok(sparseRate < 0.1, `fixture is ${(sparseRate * 100).toFixed(1)}% null and has to stay under the new one`);

    const ok = checkContract(EBAY_CONTRACT, sparse, sparse.length, frozenNow, ebayRefOf);
    assert.deepEqual(
      ok.breaches.filter((b) => b.includes("location")),
      [],
      "an ordinary deep crawl is being reported as a contract breach"
    );

    const broken = rows.map((l) => ({ ...l, location: null }));
    const fails = checkContract(EBAY_CONTRACT, broken, broken.length, frozenNow, ebayRefOf);
    assert.ok(
      fails.breaches.some((b) => b.includes("location")),
      "the location selector breaking outright must still fail the contract"
    );
  });

  it("catches a price that arrives as a formatted string", () => {
    // The realistic drift: eBay changes markup, the collector starts returning
    // "1,099.99" as text, and every arithmetic downstream silently breaks.
    const drifted = normaliseEbay(sample).map((l) => ({ ...l, price: "1,099.99" }));
    const report = checkContract(EBAY_CONTRACT, drifted, drifted.length, frozenNow, ebayRefOf);
    assert.equal(report.passed, false);
    assert.ok(report.breaches.some((b) => b.includes("price") && b.includes("number")));
  });
});

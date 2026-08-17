// Query building is where a plausible-looking bug does the most damage: a query that
// is subtly too narrow returns zero listings, and zero listings reads exactly like
// "nothing recalled is on sale". These tests pin the cases that produced wrong
// queries on the real CPSC sample.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildQueries, buildQuery } from "./query.js";
import { normaliseCpsc } from "./sources/cpsc.js";
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

function queryFor(ref: string): string {
  const recall = recalls.find((r) => r.ref === ref);
  assert.ok(recall, `no recall ${ref} in the sample`);
  return buildQuery(recall).query;
}

describe("buildQuery on the real CPSC sample", () => {
  it("keeps the head noun instead of the size modifiers", () => {
    // "Cooluli Recalls 10-Liter and 15-Liter Minifridges Due to Fire and Burn Hazards"
    // The first attempt produced "Cooluli 10-Liter 15-Liter" and lost the only word a
    // seller is certain to have used.
    assert.equal(queryFor("26685"), "Cooluli Minifridge");
  });

  it("keeps the head noun over a leading adjective", () => {
    // "CuberShop Magnetic Speed Cubes ..." is about cubes, not about magnets.
    assert.equal(queryFor("26698"), "CuberShop Speed Cube");
  });

  it("drops hazard boilerplate entirely", () => {
    const q = queryFor("26690");
    assert.equal(q, "DUMOS Nine-Drawer Dresser");
    for (const word of ["Risk", "Serious", "Injury", "Death", "Tip"]) {
      assert.equal(q.includes(word), false, `boilerplate "${word}" survived: ${q}`);
    }
  });

  it("uses the recalled brand, not the recalling company", () => {
    // "Fastbuy Recalls Zimtown Portable Gas and Fuel Cans ..." — a shopper searches
    // for Zimtown, which is on the product, not Fastbuy, which is on the paperwork.
    assert.equal(queryFor("26700"), "Zimtown Fuel Can");
  });

  it("produces a short query for every recall in the sample", () => {
    const queries = buildQueries(recalls);
    assert.equal(queries.length, recalls.length);
    for (const q of queries) {
      // Marketplace search treats terms as AND, so length is a correctness property,
      // not a style preference.
      assert.ok(q.terms.length <= 3, `${q.ref} has too many terms: ${q.query}`);
      assert.ok(q.query.length > 0);
      assert.ok(q.url.startsWith("https://www.ebay.com/sch/i.html?_nkw="));
      assert.equal(q.url.includes(" "), false, "url was not encoded");
    }
  });
});

describe("singularisation", () => {
  const make = (title: string, brand: string | null): RecallRecord =>
    asRecall({
      ref: "T-1",
      permalink: null,
      title,
      brand,
      hazard: null,
      risk: "Unknown",
      category: null,
      affectedUnits: null,
      published: null,
      action: null,
    });

  it("strips a plural s", () => {
    assert.equal(buildQuery(make("Acme Recalls Pressure Washers Due to Fire", "Acme")).query,
      "Acme Pressure Washer");
  });

  it("strips es after a sibilant", () => {
    assert.equal(buildQuery(make("Acme Recalls Storage Boxes Due to Fire", "Acme")).query,
      "Acme Storage Box");
  });

  it("leaves a short word ending in s alone", () => {
    // "Gas" must not become "Ga".
    const q = buildQuery(make("Acme Recalls Gas Due to Fire", "Acme")).query;
    assert.equal(q.includes("Ga "), false, q);
    assert.equal(q.endsWith("Ga"), false, q);
  });

  it("leaves a known non-plural alone", () => {
    assert.equal(buildQuery(make("Acme Recalls Camera Lens Due to Fire", "Acme")).query,
      "Acme Camera Lens");
  });
});

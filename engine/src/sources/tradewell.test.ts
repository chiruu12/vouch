// Two collectors, one site, two output shapes.
//
// These tests exist because the assumption that a collector's output follows the site
// cost four minutes of credits and made a working scraper look broken. Both captures
// below are real output from real collectors over the same fixture, and the adapter has
// to satisfy the same contract from either.
//
//   collector A (c_msxhnjyofl...)  nests rows in results[], price as a number,
//                                  no currency, `listed` as a date
//   collector B (c_msxnf5nk1l...)  flat rows, price as {value,currency,symbol},
//                                  `listed_date` as a full timestamp, `item_url`
//
// Both captures are committed with seller names replaced by their hashes, because this
// repository is public and a fixture is not an exemption from that rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkContract } from "../contract.js";
import { TRADEWELL_CONTRACT, normaliseTradewell } from "./tradewell.js";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../samples/${name}`, import.meta.url), "utf8"));

const CAPTURES = [
  { name: "collector A, nested results[]", raw: load("tradewell-baseline.json") },
  { name: "collector B, flat rows", raw: load("tradewell-collector-b.json") },
];

for (const { name, raw } of CAPTURES) {
  test(`${name}: every row normalises`, () => {
    const rows = normaliseTradewell(raw);
    assert.equal(rows.length, 14, "all 14 listings should survive normalisation");
    for (const r of rows) {
      assert.match(r.id, /^TW-\d+$/, `bad id: ${r.id}`);
      assert.ok(r.title.length > 5, `bad title: ${r.title}`);
      assert.ok(r.permalink !== null, `${r.id} lost its permalink`);
    }
  });

  test(`${name}: satisfies the contract`, () => {
    const rows = normaliseTradewell(raw);
    const report = checkContract(TRADEWELL_CONTRACT, rows, null, () => new Date(), (row) => {
      const v = (row as { id?: unknown }).id;
      return typeof v === "string" ? v : "";
    });
    assert.equal(report.passed, true, `breaches: ${report.breaches.join("; ")}`);
  });

  test(`${name}: no plain seller name survives`, () => {
    const rows = normaliseTradewell(raw);
    for (const r of rows) {
      assert.equal("seller" in r, false, `${r.id} carried a plain seller through`);
      if (r.sellerKey !== undefined) assert.match(r.sellerKey, /^sk_[0-9a-f]{12}$/);
    }
  });

  test(`${name}: dates are date-only ISO whatever the source precision`, () => {
    for (const r of normaliseTradewell(raw)) {
      assert.match(r.listedOn ?? "", /^\d{4}-\d{2}-\d{2}$/, `${r.id} listedOn=${r.listedOn}`);
    }
  });

  test(`${name}: price is a finite number whichever shape it arrived in`, () => {
    for (const r of normaliseTradewell(raw)) {
      assert.equal(typeof r.price, "number", `${r.id} price=${String(r.price)}`);
      assert.ok(Number.isFinite(r.price) && (r.price ?? 0) > 0, `${r.id} price=${String(r.price)}`);
    }
  });
}

test("both collectors agree on the facts, not just the shape", () => {
  const byId = (raw: unknown) => new Map(normaliseTradewell(raw).map((r) => [r.id, r]));
  const a = byId(CAPTURES[0]!.raw);
  const b = byId(CAPTURES[1]!.raw);

  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), "different ids extracted");
  for (const [id, ra] of a) {
    const rb = b.get(id)!;
    assert.equal(ra.title, rb.title, `${id} title disagrees`);
    assert.equal(ra.price, rb.price, `${id} price disagrees`);
    assert.equal(ra.listedOn, rb.listedOn, `${id} listedOn disagrees`);
    // The same seller hashes to the same key from either collector, which is what
    // makes the key useful for de-duplication across sources.
    assert.equal(ra.sellerKey, rb.sellerKey, `${id} sellerKey disagrees`);
  }
});

test("a currency is reported only when the collector actually read one", () => {
  // Collector A extracts no currency because the page shows a bare "$". Filling in
  // "USD" from a symbol would be inventing data, so the field stays null.
  for (const r of normaliseTradewell(CAPTURES[0]!.raw)) {
    assert.equal(r.currency, null, `${r.id} invented a currency`);
  }
  // Collector B does report one, and is taken at its word.
  for (const r of normaliseTradewell(CAPTURES[1]!.raw)) {
    assert.equal(r.currency, "USD", `${r.id} dropped a currency the collector read`);
  }
});

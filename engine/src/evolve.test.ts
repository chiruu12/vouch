// What the evolver may and may not teach itself.
//
// The interesting tests here are the refusals. An evolver that learns nothing is
// useless, and one that learns the wrong thing is worse than useless, because it does
// it silently and a person only finds out when the feed is wrong. The first dry run of
// this code offered to read `shipping` as `currency` and `sellerKey` as `seller`, so
// the refusals below are not hypothetical caution.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inferAliases, applyAlias, NEVER_LEARN_INTO } from "./evolve.js";
import type { AliasChange } from "./learn/change.js";
import { mayApplyUnattended } from "./learn/policy.js";
import type { AliasStore } from "./aliases.js";

const CAPTURE_C = JSON.parse(
  readFileSync(new URL("../samples/tradewell-collector-c.json", import.meta.url), "utf8")
) as Record<string, unknown>[];

const KNOWN_REFS = CAPTURE_C.map((r) => String(r.listing_id));

/** The alias store as it stood before collector C existed, so the test can watch the
 *  evolver rediscover something a person had to patch by hand at the time. */
function storeBeforeCollectorC(): AliasStore {
  return {
    version: 1,
    sources: {
      tradewell: {
        id: ["item_id", "id", "sku"],
        permalink: ["url", "permalink", "item_url", "product_page_url"],
        title: ["title"],
        brand: ["brand"],
        price: ["price"],
        currency: ["currency"],
        condition: ["condition"],
        location: ["location"],
        listedOn: ["listed", "listed_on", "listed_date"],
        seller: ["seller", "seller_name"],
      },
    },
    log: [],
  };
}

/** `inferAliases` reads the live store, so these tests exercise it through the store the
 *  module actually loaded. To test against an older store we hand it a capture whose
 *  unknown names are the ones that store lacks. */
const cap = (rows: Record<string, unknown>[]): Parameters<typeof inferAliases>[0] => ({
  label: "test.json",
  source: "tradewell",
  rows,
});

describe("what the evolver will learn", () => {
  it("infers an identifier alias only when the values are refs it already knows", () => {
    // A rename of the identifier could silently re-key the whole feed, so shape alone
    // is not enough: the values have to be refs already in the baseline.
    const rows = CAPTURE_C.map((r) => ({ novel_id: r.listing_id, title: r.title }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    const idAlias = found.find((c) => c.canonical === "id" && c.raw === "novel_id");
    assert.ok(idAlias !== undefined, "should infer novel_id as the identifier");
    assert.equal(mayApplyUnattended(idAlias).unattended, true);
    assert.match(idAlias.evidence, /matched refs already in the baseline/);
  });

  it("refuses an identifier whose values are not in the baseline", () => {
    const rows = CAPTURE_C.map((_, i) => ({ novel_id: `ZZ-${9000 + i}`, title: "x y z" }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    assert.equal(
      found.find((c) => c.canonical === "id"),
      undefined,
      "unfamiliar refs must not be adopted as the identifier"
    );
  });

  it("infers a permalink from values that actually parse as URLs", () => {
    const rows = CAPTURE_C.map((r) => ({ detail_href: r.listing_url, title: r.title }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    assert.ok(found.some((c) => c.canonical === "permalink" && c.raw === "detail_href"));
  });
});

describe("what the evolver refuses to learn", () => {
  it("never learns into the seller field, whatever the evidence", () => {
    // The one guarantee this project makes about people rather than data. Adapters hash
    // the seller at the boundary; an alias feeding something new into `seller` would be
    // a second door into it, opened by a machine, recorded in a log nobody reads daily.
    const rows = CAPTURE_C.map(() => ({ shop_handle: "corner-shop-42", title: "a b c" }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    assert.equal(
      found.find((c) => c.canonical === "seller"),
      undefined,
      "seller must never be a learning target"
    );
  });

  it("never reads from a field whose name suggests a person", () => {
    const rows = CAPTURE_C.map((r) => ({ seller_url: r.listing_url, title: r.title }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    assert.equal(
      found.find((c) => c.raw === "seller_url"),
      undefined,
      "a seller-shaped source name is off limits even for an innocent target"
    );
  });

  it("never reads back its own hash", () => {
    const rows = CAPTURE_C.map((r) => ({ sellerKey: r.sellerKey, title: r.title }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    assert.equal(found.find((c) => c.raw === "sellerKey"), undefined);
  });

  it("does not guess at fields that are merely text", () => {
    // `isText` matches any non-empty string, so inferring `currency` or `condition`
    // from shape is guessing. The first version of this file did exactly that and
    // offered to read a shipping cost as a currency.
    const rows = CAPTURE_C.map(() => ({ some_label: "Pre-owned", title: "a b c" }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    assert.deepEqual(
      found.filter((c) => ["currency", "condition", "brand", "location"].includes(c.canonical ?? "")),
      [],
      "text-shaped fields need a person"
    );
  });

  it("leaves a field alone when the adapter can already read it", () => {
    // Filling a null is reversible. Competing with a name that already works is not.
    const rows = CAPTURE_C.map((r) => ({ listing_id: r.listing_id, another_id: r.listing_id, title: r.title }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    assert.equal(
      found.find((c) => c.raw === "another_id"),
      undefined,
      "id already resolves via listing_id, so nothing may compete with it"
    );
  });

  it("ignores a field that is missing from any row", () => {
    const rows = CAPTURE_C.map((r, i) => (i === 0 ? { title: r.title } : { maybe_id: r.listing_id, title: r.title }));
    const found = inferAliases(cap(rows), KNOWN_REFS);
    assert.equal(found.find((c) => c.raw === "maybe_id"), undefined);
  });
});

describe("applying a learned alias", () => {
  const change: AliasChange = {
    kind: "alias",
    what: "tradewell: read novel_id as id",
    evidence: "test",
    source: "tradewell",
    canonical: "id",
    raw: "novel_id",
  };

  it("appends, so an existing name keeps its precedence", () => {
    // The property that makes this safe to apply unattended: a new name is only ever
    // consulted after every name that already worked, so applying it cannot change a
    // value the engine already reads.
    const before = storeBeforeCollectorC();
    const after = applyAlias(before, change, "2026-08-18T00:00:00.000Z");
    const ids = after.sources.tradewell?.id ?? [];
    assert.deepEqual(ids.slice(0, 3), ["item_id", "id", "sku"], "existing order is untouched");
    assert.equal(ids.at(-1), "novel_id", "the new name goes last");
  });

  it("records the evidence and does not mutate the store it was given", () => {
    const before = storeBeforeCollectorC();
    const snapshot = JSON.stringify(before);
    const after = applyAlias(before, change, "2026-08-18T00:00:00.000Z");
    assert.equal(JSON.stringify(before), snapshot, "input store must not be mutated");
    const entry = after.log.at(-1);
    assert.ok(entry !== undefined);
    assert.equal(entry.applied, true);
    assert.equal(entry.reversible, true);
    assert.equal(entry.by, "evolve");
  });

  it("is idempotent", () => {
    const once = applyAlias(storeBeforeCollectorC(), change, "2026-08-18T00:00:00.000Z");
    const twice = applyAlias(once, change, "2026-08-18T00:00:00.000Z");
    assert.equal(twice.sources.tradewell?.id?.filter((x) => x === "novel_id").length, 1);
    assert.equal(twice.log.length, once.log.length, "a repeat must not add a second log entry");
  });
});

describe("the committed alias store", () => {
  it("is what the adapters actually read", () => {
    // The store is data the engine depends on, so a malformed edit should fail here
    // rather than by producing null fields on a live cycle.
    const store = JSON.parse(
      readFileSync(new URL("../learned/aliases.json", import.meta.url), "utf8")
    ) as AliasStore;
    assert.equal(typeof store.version, "number");
    for (const [source, fields] of Object.entries(store.sources)) {
      for (const [canonical, names] of Object.entries(fields)) {
        assert.ok(names.length > 0, `${source}.${canonical} has no names`);
        assert.equal(new Set(names).size, names.length, `${source}.${canonical} repeats a name`);
      }
    }
    for (const entry of store.log) {
      assert.ok(entry.evidence.length > 10, "every learned name carries its evidence");
    }
  });
});

describe("the case this was built for", () => {
  it("rediscovers, from yesterday's store, the three aliases a person patched by hand", () => {
    // Collector C arrived a day after collector B, from a near-identical intent
    // sentence, and called three fields by new names. Each one cost an edit to a source
    // file and a fresh capture committed as a test fixture. This is the whole argument
    // for the evolver existing, so it is worth checking rather than asserting: given
    // the store exactly as it stood before collector C, does the evidence lead back to
    // the same three names?
    const before = storeBeforeCollectorC();
    const found = inferAliases(cap(CAPTURE_C), KNOWN_REFS, before);
    const learned = new Map(found.map((c) => [c.canonical, c.raw]));

    assert.equal(learned.get("id"), "listing_id");
    assert.equal(learned.get("listedOn"), "date_listed");

    // And it declines the third, which is the more interesting half. I patched
    // `listing_url` into the adapter by hand at the time. The evolver does not, because
    // collector C also returns `product_page_url`, which yesterday's store already knew,
    // so `permalink` was never actually null and nothing needed learning. My edit was
    // unnecessary and I did not notice; the guard that only fills nulls did.
    assert.equal(
      learned.get("permalink"),
      undefined,
      "permalink already resolved via product_page_url, so there was nothing to learn"
    );

    assert.ok(
      found.every((c) => mayApplyUnattended(c).unattended),
      "all three fill a field that was null, so all three are safe to apply unattended"
    );

    // And applying them reproduces the store that is committed today.
    let store = before;
    for (const c of found) store = applyAlias(store, c, "2026-08-18T08:10:00.000Z");
    for (const [canonical, raw] of learned) {
      if (canonical === undefined || raw === undefined) continue;
      assert.ok(
        (store.sources.tradewell?.[canonical] ?? []).includes(raw),
        `${canonical} should now resolve via ${raw}`
      );
    }
  });

  it("finds nothing left to learn from the captures already committed", () => {
    // The other half of the same claim. Against the current store, every field in every
    // committed capture is already read, so the evolver proposes no aliases at all. An
    // evolver that keeps finding work on unchanged evidence is just noisy.
    const found = CAPTURE_C.length === 0 ? [] : inferAliases(cap(CAPTURE_C), KNOWN_REFS);
    assert.deepEqual(found, [], "nothing new to learn from a capture the adapter handles");
  });
});

describe("the second lock on the seller field", () => {
  it("names seller in the never-learn list, independently of what is inferable", () => {
    // `INFERABLE` already excludes seller, so this list is not what stops the evolver
    // today, and a test driving `inferAliases` passes whether or not it exists. That is
    // exactly why it needs asserting directly: it is the lock that still holds if
    // someone later adds seller to INFERABLE, which is a plausible thing to want to do
    // in order to hash a newly-named seller field. A mutation suite caught this test
    // passing for the wrong reason.
    assert.equal(NEVER_LEARN_INTO.has("seller"), true);
  });
});

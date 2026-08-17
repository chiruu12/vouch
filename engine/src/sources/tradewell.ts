// Tradewell fixture adapter (synthetic marketplace, docs/decisions.md §9).
//
// Written after trying to reuse the eBay adapter for this source, which failed
// completely and quietly. Two reasons, both worth stating because they generalise:
//
//  1. The collector wraps each row: the listing fields live inside `results[]`, not at
//     the top level. Scraper Studio chooses its own envelope per collector, so the
//     shape is a property of the collector rather than of the site.
//  2. eBay ids are extracted from a `/itm/<digits>` permalink. Tradewell permalinks are
//     `/item/TW-88214.html`, which that pattern never matches, so every row was
//     rejected and the run looked like a total extraction failure.
//
// The result was worse than a crash: the contract read 0 rows, called it drift, and
// spent four minutes healing a collector that was working perfectly. One adapter per
// collector is not ceremony, it is the thing that stops false repairs.
//
// This source also returns a plain seller handle, which is hashed on the way in so it
// never reaches the rest of the pipeline. See docs/decisions.md §7.

import { createHash } from "node:crypto";
import type { SourceContract } from "../contract.js";
import type { Listing } from "../match.js";

function blankToNull(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function hashSeller(name: string): string {
  return "sk_" + createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 12);
}

/** The collector nests listing fields under `results`. Accept both the nested envelope
 *  and a flat row, so a future heal that flattens the output does not break this. */
function unwrap(item: unknown): Record<string, unknown>[] {
  if (typeof item !== "object" || item === null) return [];
  const row = item as Record<string, unknown>;
  if (Array.isArray(row.results)) {
    return row.results.filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null
    );
  }
  return [row];
}

/** A price arrives as a number, a formatted string, or `{ value, currency, symbol }`,
 *  depending on which collector produced the row. Two collectors over the same fixture
 *  disagreed on this, which is the general rule restated: the output shape is a
 *  property of the collector, not of the site. */
function toPrice(raw: unknown): { price: number | null; currency: string | null } {
  if (typeof raw === "number" && Number.isFinite(raw)) return { price: raw, currency: null };
  if (typeof raw === "string") {
    // "$129.00" and "US $129.00" both appear across the variants.
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    return { price: Number.isFinite(n) && n > 0 ? n : null, currency: null };
  }
  if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    const inner = toPrice(o.value ?? o.amount);
    return { price: inner.price, currency: blankToNull(o.currency) };
  }
  return { price: null, currency: null };
}

/** The contract wants date-only ISO, and one collector returns a full timestamp.
 *  Truncating is safe; parsing anything looser is not, so anything else is null and
 *  the contract gets to complain about it. */
function toIsoDate(raw: unknown): string | null {
  const s = blankToNull(raw);
  if (s === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m?.[1] ?? null;
}

function normaliseOne(row: Record<string, unknown>): Listing | null {
  if (row.error !== undefined) return null;

  const permalink =
    blankToNull(row.url) ??
    blankToNull(row.permalink) ??
    blankToNull(row.item_url) ??
    blankToNull(row.product_page_url);
  const id = blankToNull(row.item_id) ?? blankToNull(row.id) ?? blankToNull(row.sku);
  const title = blankToNull(row.title);
  if (id === null || title === null) return null;

  const { price, currency } = toPrice(row.price);

  const seller = blankToNull(row.seller) ?? blankToNull(row.seller_name);

  const listing: Listing = {
    id,
    permalink,
    title,
    brand: blankToNull(row.brand),
    price,
    // Whatever the collector actually read. The original collector extracts no currency
    // at all, because the page shows a bare "$" glyph, and inferring "USD" from a symbol
    // would be putting in data we did not read. A collector that does report one is
    // taken at its word.
    currency: currency ?? blankToNull(row.currency),
    condition: blankToNull(row.condition),
    location: blankToNull(row.location),
    listedOn:
      toIsoDate(row.listed) ?? toIsoDate(row.listed_on) ?? toIsoDate(row.listed_date),
  };
  if (seller !== null) listing.sellerKey = hashSeller(seller);
  return listing;
}

/** Pure. No network. */
export function normaliseTradewell(raw: unknown): Listing[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: Listing[] = [];
  for (const item of list) {
    for (const row of unwrap(item)) {
      const listing = normaliseOne(row);
      if (listing !== null) out.push(listing);
    }
  }
  return out;
}

export const tradewellRefOf = (row: Record<string, unknown>): string =>
  typeof row.id === "string" ? row.id : "";

// Calibrated against the real 14-row capture. Every field this source does publish is
// mandatory, because we generate the data, so any null is drift rather than a genuinely
// absent value. `currency` is excluded rather than given a loose limit: the collector
// never returns it, so a limit would fail every healthy run.
export const TRADEWELL_CONTRACT: SourceContract = {
  version: "tradewell@1",
  sourceId: "tradewell",
  minRows: 10, // 14 on a full page-1 + page-2 crawl; 10 leaves room for delistings
  maxRowDropRate: 0.2,
  fields: {
    id: { type: "string", maxNullRate: 0, minLength: 6 }, // observed 0/14
    permalink: { type: "string", maxNullRate: 0, minLength: 20 }, // observed 0/14
    title: { type: "string", maxNullRate: 0, minLength: 8 }, // observed 0/14
    brand: { type: "string", maxNullRate: 0, minLength: 2 }, // observed 0/14
    price: { type: "number", maxNullRate: 0 }, // observed 0/14, arrives as a number
    condition: { type: "string", maxNullRate: 0, minLength: 3 }, // observed 0/14
    location: { type: "string", maxNullRate: 0, minLength: 3 }, // observed 0/14
    listedOn: { type: "date", maxNullRate: 0 }, // observed 0/14, already ISO date-only
  },
};

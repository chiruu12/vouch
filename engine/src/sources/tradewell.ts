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

function normaliseOne(row: Record<string, unknown>): Listing | null {
  if (row.error !== undefined) return null;

  const permalink = blankToNull(row.url) ?? blankToNull(row.permalink) ?? blankToNull(row.product_page_url);
  const id = blankToNull(row.item_id) ?? blankToNull(row.id) ?? blankToNull(row.sku);
  const title = blankToNull(row.title);
  if (id === null || title === null) return null;

  const rawPrice = row.price;
  const price =
    typeof rawPrice === "number" && Number.isFinite(rawPrice)
      ? rawPrice
      : typeof rawPrice === "string"
        ? // "$129.00" and "US $129.00" both appear across the variants.
          (() => {
            const n = Number(rawPrice.replace(/[^0-9.]/g, ""));
            return Number.isFinite(n) && n > 0 ? n : null;
          })()
        : null;

  const seller = blankToNull(row.seller) ?? blankToNull(row.seller_name);

  const listing: Listing = {
    id,
    permalink,
    title,
    brand: blankToNull(row.brand),
    price,
    // The collector does not extract a currency and the page only shows a "$" glyph.
    // Inferring "USD" from a symbol would be putting data in that we did not read.
    currency: blankToNull(row.currency),
    condition: blankToNull(row.condition),
    location: blankToNull(row.location),
    listedOn: blankToNull(row.listed) ?? blankToNull(row.listed_on),
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

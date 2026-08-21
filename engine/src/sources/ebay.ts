// eBay marketplace adapter. Scraped with Bright Data Scraper Studio, unlike the
// recall sources, which we fetch ourselves (docs/decisions.md §5).
//
// Every rule in this file was written against a real 169-row capture, not against a
// guess about what eBay returns. The capture is committed at
// samples/ebay-pressure-washer.json with seller names already hashed. Four things in
// it are worth knowing, because each one shapes the code below:
//
//  1. `condition` arrives with its label doubled and a tooltip glued on:
//     "New New More information - About this item condition". It is also localised,
//     so "Novo Novo Mais informações ..." appears in the same field. Matching on the
//     English tail would silently drop non-English rows, so we key on the repetition
//     instead, which is language-independent.
//  2. `price` is an object, and the sibling top-level `currency` says "US", which is
//     a site code rather than a currency. `price.currency` is the authoritative one.
//  3. `location` carries a "Located in: " prefix and is genuinely absent on ~1% of
//     rows, so its contract limit is non-zero on purpose.
//  4. There is no brand field at all. The collector never extracted one, so brand
//     agreement has to come from the title. That is a real weakening of match
//     confidence and it is recorded here rather than hidden.
//
// Seller identity is hashed on the way in, so a plain seller name never reaches the
// rest of the pipeline. See docs/decisions.md §7.

import type { SourceContract } from "../contract.js";
import type { Listing } from "../match.js";

function blankToNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function asList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  return [raw];
}

/**
 * "New New More information - About this item condition" -> "New"
 * "Novo Novo Mais informações - sobre o estado deste item" -> "Novo"
 * "Good - Refurbished Good - Refurbished More information ..." -> "Good - Refurbished"
 *
 * eBay renders the condition label twice, once visibly and once for the tooltip
 * trigger. The repetition is the reliable signal; the trailing help text is
 * localised and cannot be matched on. Greedy-first so the longest repeated prefix
 * wins, otherwise "Good - Refurbished Good - Refurbished" collapses to "Good".
 */
export function normaliseCondition(raw: unknown): string | null {
  const s = blankToNull(raw);
  if (s === null) return null;

  const repeated = /^(.+?)\s+\1(?:\s|$)/.exec(s);
  if (repeated?.[1]) return repeated[1].trim();

  // No repetition: fall back to cutting a recognisable help-text tail if present,
  // otherwise keep the value as-is rather than inventing a shape for it.
  const cut = s.split(/\s+More information\b/i)[0];
  return blankToNull(cut) ?? s;
}

/** "Located in: Ft Mill, SC, United States" -> "Ft Mill, SC, United States" */
export function normaliseLocation(raw: unknown): string | null {
  const s = blankToNull(raw);
  if (s === null) return null;
  return blankToNull(s.replace(/^located\s+in\s*:\s*/i, ""));
}

/** eBay item ids are stable and public; the numeric id is the listing's identity. */
function idFromUrl(url: string | null): string | null {
  if (url === null) return null;
  const m = /\/itm\/(\d+)/.exec(url);
  return m?.[1] ?? null;
}


function priceOf(raw: unknown): { value: number | null; currency: string | null } {
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw, currency: null };
  if (typeof raw !== "object" || raw === null) return { value: null, currency: null };
  const obj = raw as Record<string, unknown>;
  const value = typeof obj.value === "number" && Number.isFinite(obj.value) ? obj.value : null;
  return { value, currency: blankToNull(obj.currency) };
}

function normaliseOne(item: unknown): Listing | null {
  if (typeof item !== "object" || item === null) return null;
  const row = item as Record<string, unknown>;

  // A row carrying an `error` is a crawler failure, not a listing. Dropping it here
  // keeps the contract measuring extraction quality rather than transport noise.
  if (row.error !== undefined) return null;

  const permalink = blankToNull(row.listing_url) ?? blankToNull(row.product_page_url);
  const id = idFromUrl(permalink);
  const title = blankToNull(row.title);
  if (id === null || title === null) return null;

  const { value, currency } = priceOf(row.price);

  // Neither `seller_name` nor any hash of it is carried forward. An unsalted hash of a
  // public username is not anonymous: eBay usernames are enumerable, so the preimage
  // space is small enough to walk with a dictionary. Nothing in this codebase reads a
  // seller key, so deriving one bought a re-identification risk and no capability.

  const listing: Listing = {
    id,
    permalink,
    title,
    // Not extracted by the collector. Brand agreement therefore falls back to the
    // title, which is weaker; see the file header.
    brand: blankToNull(row.brand),
    price: value,
    // price.currency ("USD") over the sibling `currency` field ("US"), which is a
    // marketplace site code and not a currency at all.
    currency: currency ?? null,
    condition: normaliseCondition(row.condition),
    location: normaliseLocation(row.location),
    // eBay search results do not carry a listing date. Null rather than guessed.
    listedOn: null,
  };
  return listing;
}

/** Pure. No network. Accepts a single object or an array, like the CLI returns. */
export function normaliseEbay(raw: unknown): Listing[] {
  const out: Listing[] = [];
  for (const item of asList(raw)) {
    const listing = normaliseOne(item);
    if (listing !== null) out.push(listing);
  }
  return out;
}

/** Listings key on `id`, not `ref`. Passed to checkContract so breach evidence
 *  names real listings instead of a column of empty strings. */
export const ebayRefOf = (row: Record<string, unknown>): string =>
  typeof row.id === "string" ? row.id : "";

// Calibrated against the 169-row capture. Observed null rates are stated per field
// so a future change to these numbers has to argue with a measurement.
export const EBAY_CONTRACT: SourceContract = {
  version: "ebay@1",
  sourceId: "ebay",
  // The capture returned 169. A search legitimately returns far fewer on a narrow
  // query, and crying wolf on a quiet search would train us to ignore the contract.
  minRows: 5,
  // Marketplace result counts move constantly as listings sell and get relisted, so
  // this is much looser than a regulator's. Half the results vanishing is structural.
  maxRowDropRate: 0.5,
  fields: {
    id: { type: "string", maxNullRate: 0, minLength: 6 }, // observed 0/169
    permalink: { type: "string", maxNullRate: 0, minLength: 20 }, // observed 0/169
    title: { type: "string", maxNullRate: 0, minLength: 8 }, // observed 0/169
    price: { type: "number", maxNullRate: 0.02 }, // observed 0/169
    currency: { type: "string", maxNullRate: 0.02, minLength: 3 }, // observed 0/169 via price.currency
    condition: { type: "string", maxNullRate: 0.05, minLength: 3 }, // observed 0/169
    // Recalibrated against the query actually supervised, and against a crawl three times
    // deeper than the one this contract was first written for:
    //
    //   pressure washer, 169 rows    2 null   1.2%   <- the old 5% limit was set here
    //   cooluli study,   193 rows    4 null   2.1%
    //   cooluli live,    559 rows   25 null   4.5%
    //   cooluli cycle,   568 rows            5.6%   <- breached, and a repair was attempted
    //
    // eBay's first page is better filled in than its tail, so the rate rises with depth.
    // A repair cannot make a seller type an address, so the old limit bought a refusal and
    // a 264-second repair for a field doing exactly what the header above says it does. It
    // was measuring the marketplace, not our extraction.
    //
    // 10% is a little under twice the worst rate seen, and far below what the check is
    // actually for: a broken selector reports 100%, not 6%.
    location: { type: "string", maxNullRate: 0.1, minLength: 3 },
    // brand omitted: the collector does not extract it, so a limit here would fail
    // every healthy run. Recorded in the header as a known matching weakness.
    // listedOn omitted: never present in search results.
  },
};

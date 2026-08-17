// Linking a recall notice to a marketplace listing, and being honest about how
// weakly that link is known.
//
// The limit that shapes this whole file: recalls are frequently batch-specific
// ("serials 4400-6200", "manufactured 2025-11 through 2026-03"), and a resale
// listing almost never shows a lot code. So a title match CANNOT establish that a
// given listing is a recalled unit. It can establish that a listing is for the same
// product line as a recall, which is a materially weaker claim.
//
// We therefore publish the claim we can support, with its basis attached, and
// quarantine anything below the threshold instead of asserting it. And we never
// publish seller identity: naming a seller as selling recalled goods on a fuzzy
// title match is precisely the category of lie this project exists to avoid.
//
// The same discipline the contract layer applies to scraper output, applied to our
// own inference.

import type { RecallRecord } from "./types.js";

/** A marketplace listing, normalised. Seller identity is deliberately absent from
 *  the published shape; see `sellerKey` for the one thing we retain and why. */
export interface Listing {
  id: string;
  permalink: string | null;
  title: string;
  brand: string | null;
  price: number | null;
  currency: string | null;
  condition: string | null;
  location: string | null;
  listedOn: string | null;
  /** Opaque, stable key for de-duplicating listings from the same seller without
   *  recording who they are. Never rendered. */
  sellerKey?: string;
}

export type MatchBasis =
  /** Exact identifier agreement. The only basis that identifies a product with
   *  certainty, and it is rare: about 5% of CPSC records carry a UPC at all. */
  | "upc"
  /** Brand agrees and a model code appears in both. Strong for a product line. */
  | "brand+model"
  /** Brand agrees and several product nouns overlap. Reasonable for a product line. */
  | "brand+product"
  /** Product nouns overlap with no brand agreement. Not publishable on its own. */
  | "product-only";

export interface Match {
  recallRef: string;
  listingId: string;
  /** 0 to 1. Confidence that the listing is for the same PRODUCT LINE as the
   *  recall. Never confidence that this unit is affected; see the file header. */
  confidence: number;
  basis: MatchBasis;
  /** The tokens the match actually rests on, so a reader can judge it themselves
   *  rather than trusting the number. */
  matchedTokens: string[];
  /** False means quarantined: retained and visible as unverified, never asserted. */
  publishable: boolean;
}

/** Below this we do not assert a match. Set deliberately high: a false positive
 *  here is an accusation, and a false negative is only a miss. */
export const PUBLISH_THRESHOLD = 0.7;

const CONFIDENCE: Record<MatchBasis, number> = {
  upc: 1,
  "brand+model": 0.85,
  "brand+product": 0.72,
  "product-only": 0.3,
};

// CPSC titles are mostly hazard boilerplate. Left in, these words match everything:
// half the catalogue contains "risk" or "safety" somewhere.
const BOILERPLATE = new Set([
  "recall", "recalls", "recalled", "due", "to", "risk", "risks", "of", "serious",
  "injury", "injuries", "death", "hazard", "hazards", "from", "and", "or", "the",
  "a", "an", "with", "by", "imported", "importer", "sold", "at", "for", "in", "on",
  "new", "used", "preowned", "pre", "owned", "condition", "free", "shipping", "lot",
  "set", "pack", "item", "items", "product", "products",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !BOILERPLATE.has(t));
}

/** A model code: contains a digit and a letter, e.g. HD14P, HX18, IKPC6, CV-K17.
 *  Pure numbers are excluded, since "10" and "2026" match everything. */
function modelCodes(s: string): string[] {
  const out = new Set<string>();
  for (const raw of s.split(/[\s,;()]+/)) {
    const t = raw.replace(/[^A-Za-z0-9-]/g, "");
    if (t.length < 3 || t.length > 24) continue;
    if (!/\d/.test(t) || !/[A-Za-z]/.test(t)) continue;
    out.add(t.toLowerCase());
  }
  return [...out];
}

/**
 * CPSC titles follow recognisable shapes:
 *   "COMMOWNER Pressure Washers Recalled Due to Serious Risk ...; Imported by ..."
 *   "Cooluli Recalls 10-Liter and 15-Liter Minifridges Due to Fire and Burn Hazards"
 *   "Fastbuy Recalls Zimtown Portable Gas and Fuel Cans Due to ..."
 *
 * Everything from "Due to" onwards is hazard text, and a trailing "; Imported by X"
 * is distributor text. Cutting both leaves brand plus product, which is what we can
 * actually match on.
 */
export function parseRecallTitle(title: string): { brandGuess: string | null; product: string } {
  let head = title.split(";")[0] ?? title;
  head = head.replace(/\s+(recalled\s+)?due\s+to\s+.*$/i, "").trim();

  // "BRAND Recalls PRODUCT" puts the brand before the verb.
  const recallsAt = head.match(/^(.{2,40}?)\s+recalls\s+(.+)$/i);
  if (recallsAt) {
    return { brandGuess: (recallsAt[1] ?? "").trim() || null, product: (recallsAt[2] ?? "").trim() };
  }

  // Otherwise the brand is usually the leading all-caps or Capitalised token.
  const first = head.split(/\s+/)[0] ?? "";
  const looksLikeBrand = first.length > 1 && /^[A-Z][A-Za-z0-9&.-]*$/.test(first);
  return {
    brandGuess: looksLikeBrand ? first : null,
    product: looksLikeBrand ? head.slice(first.length).trim() : head,
  };
}

function brandsAgree(recallBrand: string | null, listingBrand: string | null, listingTitle: string): boolean {
  if (!recallBrand) return false;
  const b = recallBrand.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (b.length < 3) return false;
  const candidates = [listingBrand ?? "", listingTitle].map((s) =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "")
  );
  return candidates.some((c) => c.includes(b));
}

/**
 * Score one recall against one listing.
 *
 * `recallUpcs` is passed separately because it does not live on RecallRecord: the
 * canonical record is the shape we publish, and UPCs are a matching input.
 */
export function scoreMatch(
  recall: RecallRecord,
  listing: Listing,
  opts: { recallUpcs?: readonly string[]; recallModelSource?: string } = {}
): Match | null {
  const { brandGuess, product } = parseRecallTitle(recall.title);
  const brand = recall.brand ?? brandGuess;

  // 1. Exact identifier. Rare, but when present nothing else is needed.
  const upcs = (opts.recallUpcs ?? []).map((u) => u.replace(/\D/g, "")).filter((u) => u.length >= 8);
  if (upcs.length > 0) {
    const haystack = `${listing.title} ${listing.id}`.replace(/\D/g, "");
    const hit = upcs.find((u) => haystack.includes(u));
    if (hit) return build(recall, listing, "upc", [hit]);
  }

  const recallTokens = new Set([...tokens(product), ...tokens(brand ?? "")]);
  const listingTokens = new Set(tokens(`${listing.brand ?? ""} ${listing.title}`));
  const shared = [...recallTokens].filter((t) => listingTokens.has(t));

  const brandOk = brandsAgree(brand, listing.brand, listing.title);

  // 2. Brand plus a model code present on both sides.
  const recallCodes = modelCodes(`${product} ${opts.recallModelSource ?? ""} ${recall.affectedUnits ?? ""}`);
  const listingCodes = modelCodes(listing.title);
  const sharedCodes = recallCodes.filter((c) => listingCodes.includes(c));
  if (brandOk && sharedCodes.length > 0) {
    return build(recall, listing, "brand+model", [...new Set([...sharedCodes, ...shared])]);
  }

  // 3. Brand plus enough product nouns to be talking about the same thing.
  if (brandOk && shared.length >= 2) {
    return build(recall, listing, "brand+product", shared);
  }

  // 4. Product nouns only. Recorded so it can be shown as quarantined, because a
  //    silently dropped near-miss is its own kind of dishonesty, but never asserted.
  if (shared.length >= 2) {
    return build(recall, listing, "product-only", shared);
  }

  return null;
}

function build(recall: RecallRecord, listing: Listing, basis: MatchBasis, matchedTokens: string[]): Match {
  const confidence = CONFIDENCE[basis];
  return {
    recallRef: recall.ref,
    listingId: listing.id,
    confidence,
    basis,
    matchedTokens: matchedTokens.slice(0, 8),
    publishable: confidence >= PUBLISH_THRESHOLD,
  };
}

/** Best match per listing. A listing showing under several recalls is noise. */
export function matchListings(
  recalls: readonly RecallRecord[],
  listings: readonly Listing[],
  upcsByRef: Readonly<Record<string, readonly string[]>> = {},
  modelSourceByRef: Readonly<Record<string, string>> = {}
): Match[] {
  const best = new Map<string, Match>();

  for (const listing of listings) {
    for (const recall of recalls) {
      const opts: { recallUpcs?: readonly string[]; recallModelSource?: string } = {};
      const upcs = upcsByRef[recall.ref];
      if (upcs !== undefined) opts.recallUpcs = upcs;
      const ms = modelSourceByRef[recall.ref];
      if (ms !== undefined) opts.recallModelSource = ms;

      const m = scoreMatch(recall, listing, opts);
      if (m === null) continue;
      const incumbent = best.get(listing.id);
      if (incumbent === undefined || m.confidence > incumbent.confidence) best.set(listing.id, m);
    }
  }

  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

/** Rendered next to every match in the UI. The caveat is not a disclaimer bolted on
 *  afterwards; it is the actual epistemic status of the number. */
export const MATCH_CAVEAT =
  "Matched on product line, not on unit. Recalls are often limited to specific batches " +
  "or serial ranges, and marketplace listings rarely show them, so a match here means " +
  "this listing appears to be the same product as a recall, not that this particular " +
  "item is affected.";

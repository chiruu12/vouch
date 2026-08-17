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
import { mentionsAccessory, singular } from "./text.js";

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
  /** Set when the listing states an attribute the recall rules out, e.g. a capacity
   *  outside the recalled range. Non-null always forces `publishable` false. */
  contradiction: string | null;
}

/** Below this we do not assert a match. Set deliberately high: a false positive
 *  here is an accusation, and a false negative is only a miss. */
export const PUBLISH_THRESHOLD = 0.7;

/** Ceiling applied when the listing contradicts the recall on a stated attribute.
 *  Deliberately under the threshold: contradicted matches are kept and shown as
 *  quarantined, never asserted. */
const CONTRADICTED_CONFIDENCE = 0.35;

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
  // Units of measure. Measured, not guessed: the Cooluli recall names "10-Liter and
  // 15-Liter Minifridges", and leaving "liter" in matched every Cooluli fridge on the
  // marketplace including the 4L and 20L models that were never recalled. A unit is
  // never what makes two products the same product.
  "liter", "liters", "litre", "litres", "ml", "oz", "qt", "gal", "gallon", "gallons",
  "inch", "inches", "cm", "mm", "psi", "gpm", "watt", "watts", "volt", "volts",
  "lb", "lbs", "kg", "quart", "quarts", "pint", "pints",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    // Bare numbers match anything. The recall "10-Liter and 15-Liter Minifridges"
    // leaves the tokens "10" and "15", and "10" duly matched "10 FT POWER CABLE".
    // Capacity is handled by capacities() as negative evidence instead.
    .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !BOILERPLATE.has(t))
    .map(singular);
}

/**
 * Tokens plus adjacent-pair concatenations, so an open compound matches a closed one.
 *
 * Regulators write "Minifridges"; sellers write "Mini Fridge". Without this, the most
 * obviously matching listing on the marketplace ("BRAND NEW MINI FRIDGE- COOLULI")
 * scored nothing at all, which is the worst kind of miss: it looks like a clean
 * result. Bigrams are cheap and need no lexicon.
 */
function tokenSet(s: string): Set<string> {
  const list = tokens(s);
  const set = new Set(list);
  for (let i = 0; i + 1 < list.length; i++) set.add(`${list[i]}${list[i + 1]}`);
  return set;
}

/** Capacities named in a string, normalised to litres-as-written: "10-Liter", "15 L",
 *  "4L" all yield a number. Used as negative evidence, never positive. */
function capacities(s: string): Set<number> {
  const out = new Set<number>();
  const re = /(\d+(?:\.\d+)?)\s*-?\s*(?:l|liters?|litres?)\b/gi;
  for (const m of s.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out;
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
    if (hit) return build(recall, listing, "upc", [hit], null);
  }

  const recallTokens = tokenSet(`${product} ${brand ?? ""}`);
  const listingTokens = tokenSet(`${listing.brand ?? ""} ${listing.title}`);
  const shared = [...recallTokens].filter((t) => listingTokens.has(t));

  // Closed compounds in the notice against the plain noun in the listing. The
  // regulator writes "Minifridges"; a real recalled unit was listed as "Cooluli
  // Infinity Black 15 Liter fridge", which shares only the brand and was therefore
  // missed entirely. Decomposing the recall's compound recovers it.
  //
  // One-directional on purpose, and only when the RECALL holds the long compound.
  // The reverse would let a listing for a "dishwasher" match a recall for a "washer",
  // which is a different appliance with a different hazard.
  for (const r of recallTokens) {
    if (r.length < 8) continue;
    for (const l of listingTokens) {
      if (l.length >= 5 && l.length < r.length && r.endsWith(l) && !shared.includes(l)) {
        shared.push(l);
      }
    }
  }

  const brandOk = brandsAgree(brand, listing.brand, listing.title);

  // Negative evidence. If the recall names specific capacities and the listing names
  // a different one, this is the same product line but demonstrably not an affected
  // unit. The Cooluli recall covers 10L and 15L; the marketplace is full of 4L, 12L
  // and 20L units that were never recalled. Asserting those would be exactly the
  // over-claim this file exists to prevent, so a contradiction demotes the match into
  // quarantine rather than deleting it, and the reason travels with it.
  const recallCaps = capacities(`${recall.title} ${recall.affectedUnits ?? ""}`);
  const listingCaps = capacities(listing.title);
  const capacityClash =
    recallCaps.size > 0 && listingCaps.size > 0 && ![...listingCaps].some((c) => recallCaps.has(c))
      ? `recall covers ${[...recallCaps].join("L, ")}L; this listing states ${[...listingCaps].join("L, ")}L`
      : null;

  // The other way a strong token match is still the wrong thing: the listing is for an
  // accessory. A replacement power cable for a recalled fridge shares the brand and the
  // product noun with the recall while being a completely different item, and three of
  // the first four Cooluli matches were exactly this.
  const listingAccessory = mentionsAccessory([...listingTokens]);
  const recallAccessory = mentionsAccessory([...recallTokens]);
  const accessoryClash =
    listingAccessory !== null && recallAccessory === null
      ? `listing is for an accessory ("${listingAccessory}"), not the recalled product`
      : null;

  const contradiction = capacityClash ?? accessoryClash;

  // 2. Brand plus a model code present on both sides.
  const recallCodes = modelCodes(`${product} ${opts.recallModelSource ?? ""} ${recall.affectedUnits ?? ""}`);
  const listingCodes = modelCodes(listing.title);
  const sharedCodes = recallCodes.filter((c) => listingCodes.includes(c));
  if (brandOk && sharedCodes.length > 0) {
    return build(recall, listing, "brand+model", [...new Set([...sharedCodes, ...shared])], contradiction);
  }

  // 3. Brand plus enough product nouns to be talking about the same thing.
  if (brandOk && shared.length >= 2) {
    return build(recall, listing, "brand+product", shared, contradiction);
  }

  // 4. Product nouns only. Recorded so it can be shown as quarantined, because a
  //    silently dropped near-miss is its own kind of dishonesty, but never asserted.
  if (shared.length >= 2) {
    return build(recall, listing, "product-only", shared, contradiction);
  }

  return null;
}

/** `contradiction` is negative evidence, so it caps confidence below the publish
 *  threshold no matter how well the tokens agreed. The basis is left as detected: a
 *  reader is better served by "brand+product, but the capacity disagrees" than by a
 *  match silently relabelled as weak. */
function build(
  recall: RecallRecord,
  listing: Listing,
  basis: MatchBasis,
  matchedTokens: string[],
  contradiction: string | null
): Match {
  const base = CONFIDENCE[basis];
  const confidence = contradiction === null ? base : Math.min(base, CONTRADICTED_CONFIDENCE);
  return {
    recallRef: recall.ref,
    listingId: listing.id,
    confidence,
    basis,
    matchedTokens: matchedTokens.slice(0, 8),
    publishable: confidence >= PUBLISH_THRESHOLD,
    contradiction,
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

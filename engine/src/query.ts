// Turning a recall notice into a marketplace search.
//
// The first attempt at measuring match rate scraped one search I picked by hand
// ("pressure washer") and compared it against six unrelated recalls. It produced one
// weak match out of 169 listings, which said nothing about the matcher and everything
// about the experiment: five of the six recalls were for products nobody had
// searched for.
//
// The search has to be derived from the recall, which is also how the product
// actually works. The question is not "what is on this search page that was
// recalled", it is "for this specific recall, is the product still on sale".
//
// Queries stay deliberately short. Marketplace search engines treat extra terms as
// additional constraints, so a long query built from a full CPSC title returns
// nothing at all and looks like a clean result.

import type { RecallRecord } from "./types.js";
import { parseRecallTitle } from "./match.js";
import { singular } from "./text.js";

/** Hazard and legal boilerplate. CPSC titles are mostly this, and every word of it
 *  narrows a marketplace search towards zero results. */
const DROP = new Set([
  "recall", "recalls", "recalled", "due", "to", "risk", "risks", "of", "serious",
  "injury", "injuries", "death", "hazard", "hazards", "from", "and", "or", "the",
  "a", "an", "with", "by", "imported", "importer", "sold", "at", "for", "in", "on",
  "because", "may", "can", "could", "after", "reports", "report", "including",
  "shock", "fire", "burn", "burns", "tip", "over", "entrapment", "laceration",
  "electrocution", "strangulation", "suffocation", "choking", "violation",
  "federal", "standard", "regulations", "safety", "consumer", "product", "products",
]);

/** Units and sizes. "10-Liter" is how the regulator writes it and "10L" is how the
 *  seller writes it, so including either one loses the other. Neither is worth the
 *  precision it costs. */
const UNITY =
  /^(?:\d+(?:\.\d+)?)?-?(?:l|litre|litres|liter|liters|ml|oz|qt|gal|gallon|gallons|in|inch|inches|cm|mm|ft|lb|lbs|kg|g|psi|gpm|v|w|watt|watts|ah|mah)$/i;

function meaningful(tok: string): boolean {
  const t = tok.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (t.length < 3) return false;
  if (DROP.has(t)) return false;
  if (UNITY.test(t)) return false;
  if (/^\d+(?:-\d+)?$/.test(t)) return false; // bare numbers and ranges
  return true;
}

export interface RecallQuery {
  ref: string;
  /** The search phrase, brand first. */
  query: string;
  /** A ready-to-scrape eBay search URL. */
  url: string;
  /** Terms the query rests on, so a zero-result search can be explained. */
  terms: string[];
}

/**
 * Brand plus at most `maxProductTerms` product nouns. Brand first because it is the
 * single most discriminating term, and because a brand-only search still returns
 * something useful when the product nouns are wrong.
 */
export function buildQuery(recall: RecallRecord, maxProductTerms = 2): RecallQuery {
  const { brandGuess, product } = parseRecallTitle(recall.title);
  const brand = (recall.brand ?? brandGuess ?? "").trim();

  const brandWords = new Set(
    brand.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, ""))
  );

  // Collect every usable token, then keep the TAIL rather than the head. English
  // noun phrases put the head noun last, so "Magnetic Speed Cubes" is about cubes and
  // "Nine-Drawer Dressers" is about dressers. Taking the first tokens keeps the
  // adjectives and throws away the only word a seller is certain to have used.
  const candidates: string[] = [];
  for (const raw of product.split(/[\s,;()]+/)) {
    if (!meaningful(raw)) continue;
    const tok = singular(raw.replace(/[^A-Za-z0-9-]/g, ""));
    if (tok === "") continue;
    if (brandWords.has(tok.toLowerCase())) continue; // already carried by the brand
    if (candidates.some((t) => t.toLowerCase() === tok.toLowerCase())) continue;
    candidates.push(tok);
  }
  const productTerms = candidates.slice(Math.max(0, candidates.length - maxProductTerms));

  const terms = [...(brand === "" ? [] : [brand]), ...productTerms];
  const query = terms.join(" ").trim();

  return {
    ref: recall.ref,
    query,
    url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`,
    terms,
  };
}

export function buildQueries(recalls: readonly RecallRecord[], maxProductTerms = 2): RecallQuery[] {
  return recalls.map((r) => buildQuery(r, maxProductTerms)).filter((q) => q.query !== "");
}

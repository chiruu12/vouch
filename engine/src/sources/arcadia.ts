// Arcadia fixture adapter: raw Scraper Studio output into the canonical shape.
//
// This file exists because of a bug worth keeping the memory of. The cycle was wired
// straight from the CLI to the contract, so the contract compared its canonical field
// names (`ref`, `title`, `risk`) against the collector's own names (`reference`,
// `product_title`, `risk_level`). Every field read as 100% null, the contract reported
// total failure on perfectly good data, and the engine went off and healed a scraper
// that was working correctly.
//
// A wrong contract does not fail safe. It manufactures exactly the unnecessary repair
// this project argues against, so the adapter layer is load-bearing rather than tidy.
//
// Each canonical field lists several accepted source names, because a heal renames
// output fields as well as rewriting selectors: healing through a page that relabelled
// "Batch codes" to "Affected units" made the collector rename `batch_codes` to
// `affected_units` on its own. See docs/decisions.md §4.

import type { RecallRecord, RiskLevel } from "../types.js";

type Candidate = Omit<RecallRecord, "provenance">;

const RISK_LEVELS = new Set<string>(["Serious", "High", "Medium", "Low"]);

/** First alias that carries a usable value wins. Order is most-recent-first, so a
 *  post-heal name is preferred over the name it replaced. */
function pick(row: Record<string, unknown>, ...names: string[]): string | null {
  for (const n of names) {
    const v = row[n];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Arcadia renders the reference as "Reference APS-2026-0416". The label is part of
 *  the visible text, so it arrives inside the value. */
export function cleanRef(raw: string | null): string | null {
  if (raw === null) return null;
  const s = raw.replace(/^reference\s*[:#]?\s*/i, "").trim();
  return s === "" ? null : s;
}

/** The contract requires date-only ISO. Long-form dates appear after a redesign, and
 *  the whole point of the type check is that an unnormalised date is caught, so this
 *  parses what it can and returns null rather than guessing. */
export function toIsoDate(raw: string | null): string | null {
  if (raw === null) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (iso?.[1]) return iso[1];

  // "14 April 2026" / "April 14, 2026", which is how the redesign variant writes it.
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

function toRisk(raw: string | null): RiskLevel {
  if (raw === null) return "Unknown";
  const t = raw.trim();
  if (RISK_LEVELS.has(t)) return t as RiskLevel;
  // The redesign nests the value in a band element, so it can arrive as "Risk: High".
  const m = /\b(Serious|High|Medium|Low)\b/i.exec(t);
  if (m?.[1]) {
    const w = m[1].toLowerCase();
    return ((w[0]?.toUpperCase() ?? "") + w.slice(1)) as RiskLevel;
  }
  return "Unknown";
}

function normaliseOne(item: unknown): Candidate | null {
  if (typeof item !== "object" || item === null) return null;
  const row = item as Record<string, unknown>;
  if (row.error !== undefined) return null;

  const ref = cleanRef(pick(row, "reference", "ref", "notice_reference", "notice_ref"));
  const title = pick(row, "product_title", "title", "product", "product_name");
  if (ref === null || title === null) return null;

  return {
    ref,
    permalink: pick(row, "product_page_url", "permalink", "notice_url", "url"),
    title,
    brand: pick(row, "brand", "manufacturer", "brand_name"),
    hazard: pick(row, "hazard", "hazard_description", "defect"),
    risk: toRisk(pick(row, "risk_level", "risk", "risk_band")),
    category: pick(row, "category", "product_category"),
    // affected_units is the post-heal name; batch_codes is what it was called before
    // the page relabelled that column.
    affectedUnits: pick(row, "affected_units", "batch_codes", "affected", "batch"),
    published: toIsoDate(pick(row, "published_date", "published", "date_published", "date")),
    action: pick(row, "consumer_action", "action", "advice", "what_to_do"),
  };
}

/** Pure. No network. */
export function normaliseArcadia(raw: unknown): Candidate[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: Candidate[] = [];
  for (const item of list) {
    const rec = normaliseOne(item);
    if (rec !== null) out.push(rec);
  }
  return out;
}

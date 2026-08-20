// US CPSC recall adapter. Official JSON, fetched by us; Bright Data is not involved.
// See docs/decisions.md §5.

import type { SourceContract } from "../contract.js";
import type { RecallRecord, SourceAdapter } from "../types.js";

/** Exported so the cycle can probe the same URL it fetches from. A listing probe that
 *  watches a different address than the collector reads is how a wall on one path stays
 *  invisible from the other. */
export const CPSC_ENDPOINT = "https://www.saferproducts.gov/RestWebServices/Recall";
const ENDPOINT = CPSC_ENDPOINT;
const LOOKBACK_DAYS = 180;

type Candidate = Omit<RecallRecord, "provenance">;

/** Words that start a product description, not a brand. Conservative on purpose. */
const PRODUCT_WORDS = new Set([
  "can",
  "cans",
  "container",
  "containers",
  "cube",
  "cubes",
  "drawer",
  "drawers",
  "dresser",
  "dressers",
  "electric",
  "fuel",
  "gas",
  "magnetic",
  "minifridge",
  "minifridges",
  "model",
  "models",
  "nine-drawer",
  "portable",
  "pressure",
  "speed",
  "stickerless",
  "washer",
  "washers",
]);

function blankToNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function asList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  return [raw];
}

function firstRecord(v: unknown): Record<string, unknown> | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const first = v[0];
  if (typeof first !== "object" || first === null) return null;
  return first as Record<string, unknown>;
}

function named(v: unknown): string | null {
  const rec = firstRecord(v);
  return rec ? blankToNull(rec.Name) : null;
}

function toIsoDate(v: unknown): string | null {
  const s = blankToNull(v);
  if (s === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m?.[1] ?? null;
}

function refOf(row: Record<string, unknown>): string | null {
  const n = blankToNull(row.RecallNumber);
  if (n !== null) return n;
  return blankToNull(row.RecallID);
}

function looksBrandToken(tok: string): boolean {
  const core = tok.replace(/[^A-Za-z0-9-]/g, "");
  if (!core) return false;
  if (PRODUCT_WORDS.has(core.toLowerCase())) return false;
  return /^[A-Z]/.test(core);
}

function leadingBrand(phrase: string): string | null {
  const kept: string[] = [];
  for (const tok of phrase.trim().split(/\s+/)) {
    if (!looksBrandToken(tok)) break;
    kept.push(tok.replace(/[,;:]+$/, ""));
  }
  const s = kept.join(" ").trim();
  return s === "" ? null : s;
}

function brandOf(product: Record<string, unknown> | null, title: string): string | null {
  const name = product ? blankToNull(product.Name) : null;
  if (name !== null) {
    const head = name.split(",")[0] ?? name;
    const fromName = leadingBrand(head);
    if (fromName !== null) return fromName;
  }

  // "Cooluli Recalls ..." / "Fastbuy Recalls Zimtown ..."
  const recalls = /^(.+?)\s+Recalls\b/i.exec(title);
  const recallsBrand = recalls?.[1]?.trim();
  if (recallsBrand) return recallsBrand;

  // "COMMOWNER Pressure Washers Recalled ..."
  const recalled = /^(.+?)\s+Recalled\b/i.exec(title);
  const recalledHead = recalled?.[1];
  if (recalledHead) return leadingBrand(recalledHead);

  return null;
}

function affectedUnitsOf(product: Record<string, unknown> | null): string | null {
  if (product === null) return null;
  const model = blankToNull(product.Model);
  if (model !== null) return model;
  const desc = blankToNull(product.Description);
  if (desc !== null) return desc;
  const units = blankToNull(product.NumberOfUnits);
  if (units === null) return null;
  return /unit/i.test(units) ? units : `${units} units`;
}

function lookbackStart(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - LOOKBACK_DAYS);
  return d.toISOString().slice(0, 10);
}

function normaliseOne(item: unknown): Candidate | null {
  if (typeof item !== "object" || item === null) return null;
  const row = item as Record<string, unknown>;
  const ref = refOf(row);
  const title = blankToNull(row.Title);
  if (ref === null || title === null) return null;

  const product = firstRecord(row.Products);

  return {
    ref,
    permalink: blankToNull(row.URL),
    title,
    brand: brandOf(product, title),
    hazard: named(row.Hazards),
    risk: "Unknown",
    category: product ? blankToNull(product.Type) : null,
    affectedUnits: affectedUnitsOf(product),
    published: toIsoDate(row.RecallDate),
    action: named(row.Remedies),
  };
}

/** Pure. No network. The API may hand back one object or an array. */
export function normaliseCpsc(raw: unknown): Candidate[] {
  const out: Candidate[] = [];
  for (const item of asList(raw)) {
    const rec = normaliseOne(item);
    if (rec !== null) out.push(rec);
  }
  return out;
}

async function fetchCpsc(): Promise<Candidate[]> {
  const url = `${ENDPOINT}?format=json&RecallDateStart=${lookbackStart()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`CPSC fetch failed: HTTP ${res.status}`);
  }
  return normaliseCpsc(await res.json());
}

export const cpscAdapter: SourceAdapter = {
  id: "cpsc",
  label: "US CPSC",
  scraped: false,
  fetch: fetchCpsc,
};

// Limits are sample-calibrated (6 rows in cpsc-sample.json), plus a little headroom.
// A contract that fails on healthy data is worse than no contract.
export const CPSC_CONTRACT: SourceContract = {
  version: "cpsc@1",
  sourceId: "cpsc",
  minRows: 1, // sample has 6; live windows vary. 1 avoids crying wolf on a quiet week.
  maxRowDropRate: 0.5, // withdrawals are gradual; a 50% drop is structural.
  fields: {
    ref: { type: "string", maxNullRate: 0.1 }, // observed 0/6
    title: { type: "string", maxNullRate: 0.1 }, // observed 0/6
    permalink: { type: "string", maxNullRate: 0.1 }, // observed 0/6
    brand: { type: "string", maxNullRate: 0.2 }, // observed 0/6 via best-effort parse; titles vary
    hazard: { type: "string", maxNullRate: 0.2 }, // observed 0/6; Hazards may be []
    // risk omitted: always "Unknown", never null (observed 0/6)
    category: { type: "string", maxNullRate: 1 }, // observed 6/6: Products[].Type is ""
    affectedUnits: { type: "string", maxNullRate: 0.2 }, // observed 0/6 from NumberOfUnits
    published: { type: "date", maxNullRate: 0.1 }, // observed 0/6
    action: { type: "string", maxNullRate: 0.2 }, // observed 0/6; Remedies may be []
  },
};

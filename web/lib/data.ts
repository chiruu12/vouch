// Load the snapshot the supervision cycle published.
//
// The types come straight from the engine rather than being restated here. A second
// copy of the published shape would drift, and the first symptom of that drift would
// be the feed rendering a trust state it no longer understands as plain text. One
// definition, imported type-only, so none of the engine's node: dependencies come
// along for the ride.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PubIncident, PubListing, PubRecall, Snapshot } from "../../engine/src/snapshot.js";

export type { PubIncident, PubListing, PubRecall, Snapshot };

let cached: Snapshot | null = null;

export function snapshot(): Snapshot {
  if (cached === null) {
    cached = JSON.parse(readFileSync(join(process.cwd(), "public", "snapshot.json"), "utf8")) as Snapshot;
  }
  return cached;
}

/** A timestamp a reader can check against their own clock. Kept in UTC on purpose:
 *  the useful question about a recall feed is "how stale is this", and a localised
 *  string invites the reader to guess at the offset. */
export function stamp(iso: string | null): string {
  if (iso === null) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
  );
}

export function dateOnly(iso: string | null): string {
  return iso === null ? "not stated" : iso.slice(0, 10);
}

export function seconds(ms: number | null): string {
  return ms === null ? "unresolved" : `${(ms / 1000).toFixed(1)}s`;
}

/** The Tradewell collector reads a price but not a currency, because the page shows a
 *  bare "$" glyph and inferring USD from a symbol would be adding data we did not read.
 *  So the number is shown without a unit and the omission is stated once, rather than
 *  a plausible currency being filled in. */
export function money(price: number | null, currency: string | null): string {
  if (price === null) return "price not extracted";
  const n = price.toFixed(2);
  return currency === null ? `${n} (currency not extracted)` : `${n} ${currency}`;
}

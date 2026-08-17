// The canonical shapes every source normalises into, and the vocabulary the
// classifier and the feed both speak. This file is the contract between the
// source adapters, the engine, and the web feed. Change it deliberately.

export type SourceId = "arcadia" | "cpsc" | "eu-safety-gate" | "uk-opss";

export type RiskLevel = "Serious" | "High" | "Medium" | "Low" | "Unknown";

/**
 * Why a probe failed. The whole project turns on this distinction: two of these
 * are repaired, two of them must never be repaired.
 *
 *   drift       the page still publishes the data, in a different shape   -> heal
 *   pagination  the listing still exists, paging scheme moved             -> heal
 *   blocked     bot wall, rate limit, captcha. Healing cannot fix being
 *               refused at the door, and trying wastes credits            -> back off
 *   gone        the notice was withdrawn and its permalink 404s. Healing
 *               here invents a replacement and republishes a phantom
 *               safety recall, which is the failure this exists to stop   -> never heal
 */
export type FailureCause = "drift" | "pagination" | "blocked" | "gone";

/** What we are willing to say about a record when we serve it. */
export type RecordState =
  /** Extracted by a scraper whose last probe satisfied its contract. */
  | "verified"
  /** Extracted after a heal that we then verified against the contract. */
  | "healed"
  /** Last-good copy. The source is currently failing its contract, so we do not
   *  claim this is current. Shown, but visibly stale. */
  | "unverified"
  /** The regulator withdrew this notice. Retained for the record, never healed,
   *  never presented as an active recall. */
  | "withdrawn";

export interface HealEvent {
  at: string; // ISO 8601
  cause: FailureCause;
  /** The evidence-carrying prompt we synthesised and sent to `bdata scraper heal`. */
  prompt: string;
  /** Did the healed draft satisfy the contract when we re-probed it? */
  verified: boolean;
  /** Did we save the draft to production, or discard it? */
  promoted: boolean;
  collectorId: string;
  durationMs: number;
}

export interface Provenance {
  sourceId: SourceId;
  fetchedAt: string; // ISO 8601
  /** Which version of the source's contract this record was checked against. */
  contractVersion: string;
  state: RecordState;
  /** Last time a probe of this source satisfied its contract. Null if never. */
  lastVerifiedAt: string | null;
  healHistory: HealEvent[];
}

/** One recall notice, normalised across regulators. */
export interface RecallRecord {
  /** The regulator's own reference. Unique within a source, not across sources. */
  ref: string;
  /** The notice's own public URL. This is the withdrawal oracle: when it stops
   *  resolving, the notice is gone rather than merely restyled. Null when the
   *  source publishes no per-notice permalink. */
  permalink: string | null;
  title: string;
  brand: string | null;
  hazard: string | null;
  risk: RiskLevel;
  category: string | null;
  /** Batch codes, lot numbers, serial ranges. Free text; regulators do not agree. */
  affectedUnits: string | null;
  /** ISO 8601 date, date-only precision. Null when the source omits it. */
  published: string | null;
  /** What a consumer is told to do. */
  action: string | null;
  provenance: Provenance;
}

/** A source adapter: anything that can produce normalised records. */
export interface SourceAdapter {
  id: SourceId;
  /** Human label for the feed's health strip. */
  label: string;
  /** True when records come from a Bright Data Scraper Studio collector, false
   *  when the regulator already publishes machine-readable data. The feed says
   *  which, because "we scraped this" and "they published this" are different
   *  reliability claims. */
  scraped: boolean;
  /** Fetch the current listing. Throws on transport failure; returns whatever it
   *  could parse otherwise, so the contract check can judge completeness. */
  fetch(): Promise<Omit<RecallRecord, "provenance">[]>;
}

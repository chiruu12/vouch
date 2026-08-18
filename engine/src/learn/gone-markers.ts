// Learning what "this record is gone" looks like on a site nobody has read yet.
//
// `GONE_MARKERS` in bdata.ts is a hand-written list of phrases, and it is deliberately
// narrow because a false marker takes a live safety recall off the feed. Narrow also
// means it only knows the sites it was written against: point the oracle at a new
// marketplace and a removed listing that answers 200 with its own wording reads as
// merely lost, which is the one verdict that authorises a repair.
//
// The evidence to fix that arrives for free, already labelled, every time the oracle
// runs. A permalink answering 404 or 410 is gone, by the status line and not by
// inference. A permalink answering 200 for a record still present in the listing is
// live. So every probe is a labelled example, and a phrase that shows up only ever on
// the gone side is a candidate marker.
//
// Two rules shape the implementation more than anything else:
//
//   Pages are never stored. A marketplace page carries seller names, and this project
//   promises they do not survive contact with it. Phrases are extracted at probe time
//   and only the phrase and its counts are written down, so there is no body on disk to
//   leak and no second door into the guarantee.
//
//   A candidate needs corroboration across records. A phrase seen on one gone page is
//   as likely to be that listing's own text, including a seller's name, as it is to be
//   the site's removal notice. Requiring distinct records is what separates the site's
//   wording from one page's content.

import { visibleText } from "../html.js";

/** What we remember about a phrase, which is only ever counts and which records. */
export { visibleText };

export interface PhraseRecord {
  /** Distinct refs whose page was proved gone and carried this phrase. Capped: the
   *  count is what matters and an unbounded list is a slow leak of identifiers. */
  goneRefs: string[];
  /** Distinct refs proved live whose page carried it. One is enough to disqualify. */
  liveRefs: string[];
}

export interface PhraseLedger {
  version: number;
  sources: Record<string, Record<string, PhraseRecord>>;
}

export const emptyLedger = (): PhraseLedger => ({ version: 1, sources: {} });

export type Verdict = "gone" | "live";

/** How many distinct gone records must carry a phrase before it is worth a person's
 *  attention. Two is the smallest number that can distinguish a site's own wording from
 *  one listing's content, and every candidate is reviewed by hand anyway. */
export const MIN_DISTINCT_GONE = 2;

const MAX_REFS_KEPT = 8;
const MIN_PHRASE = 10;
const MAX_PHRASE = 80;

/** Short standalone lines of visible text, normalised.
 *
 *  Candidates are whole short segments rather than every n-gram, because that is the
 *  shape these messages actually take: a site says "This listing was ended by the
 *  seller" on its own line. Mining every n-gram of a two-megabyte page would produce
 *  hundreds of thousands of candidates, almost all of them fragments of navigation. */
export function candidatePhrases(html: string): string[] {
  const out = new Set<string>();
  for (const raw of visibleText(html).split(/[\n.!?|•]+/)) {
    const phrase = raw.replace(/\s+/g, " ").trim().toLowerCase().replace(/[,;:]+$/, "");
    if (phrase.length < MIN_PHRASE || phrase.length > MAX_PHRASE) continue;
    // Letters and ordinary spacing only. This drops prices, identifiers, dates and
    // anything carrying a handle, none of which are ever a site's removal wording.
    if (!/^[a-z][a-z' -]*[a-z]$/.test(phrase)) continue;
    // A message, not a single word or a two-word nav label.
    if (phrase.split(" ").length < 3) continue;
    out.add(phrase);
  }
  return [...out];
}

function add(list: string[], ref: string): string[] {
  if (list.includes(ref)) return list;
  return list.length >= MAX_REFS_KEPT ? list : [...list, ref];
}

/** Record what one probed page said, without keeping the page.
 *
 *  Pure: takes a ledger and returns the next one, so the caller decides when anything
 *  is written and a test can drive a whole history without touching disk. */
export function observePage(
  ledger: PhraseLedger,
  source: string,
  ref: string,
  html: string,
  verdict: Verdict
): PhraseLedger {
  const next: PhraseLedger = { version: ledger.version, sources: { ...ledger.sources } };
  const forSource = { ...(next.sources[source] ?? {}) };
  for (const phrase of candidatePhrases(html)) {
    const prev = forSource[phrase] ?? { goneRefs: [], liveRefs: [] };
    forSource[phrase] =
      verdict === "gone"
        ? { goneRefs: add(prev.goneRefs, ref), liveRefs: prev.liveRefs }
        : { goneRefs: prev.goneRefs, liveRefs: add(prev.liveRefs, ref) };
  }
  next.sources[source] = forSource;
  return next;
}

export interface MarkerCandidate {
  source: string;
  marker: string;
  goneRefs: number;
  liveRefs: number;
}

/** Phrases that only ever appeared on pages proved gone.
 *
 *  `liveRefs === 0` is the load-bearing condition and it is an allowlist, not a
 *  blocklist: a phrase is offered because nothing contradicted it, not because it
 *  looked like removal wording. The same shape as the oracle it feeds, for the same
 *  reason. Presence of the site's own removal message is the claim that costs
 *  something, so it has to be the thing that is proved. */
export function proposeMarkers(
  ledger: PhraseLedger,
  known: readonly string[],
  minDistinctGone: number = MIN_DISTINCT_GONE
): MarkerCandidate[] {
  const lowered = known.map((k) => k.toLowerCase());
  const out: MarkerCandidate[] = [];
  for (const [source, phrases] of Object.entries(ledger.sources)) {
    for (const [marker, rec] of Object.entries(phrases)) {
      if (rec.liveRefs.length > 0) continue;
      if (rec.goneRefs.length < minDistinctGone) continue;
      // Already covered, either exactly or as a substring of what we look for.
      if (lowered.some((k) => marker.includes(k))) continue;
      out.push({
        source,
        marker,
        goneRefs: rec.goneRefs.length,
        liveRefs: rec.liveRefs.length,
      });
    }
  }
  // Most corroborated first, then shortest, because a shorter phrase generalises and is
  // easier for a reviewer to judge.
  return out.sort((a, b) => b.goneRefs - a.goneRefs || a.marker.length - b.marker.length);
}

// Vouch as a context service: the same feed, answered for something that will act on
// the answer rather than read it.
//
// The website and this module publish from one snapshot and disagree about almost
// nothing except who is asking. A person reading a page sees "unverified, last checked
// four hours ago" in the margin and discounts the row accordingly. A model handed the
// same row as JSON flattens it into a sentence, and the margin is the first thing lost.
// Provenance carried as a sibling field is advisory, and advisory is not a guarantee.
//
// So the guarantee moves into the shape of the reply. What we will not vouch for is not
// labelled, it is ABSENT, and reported as a count with a reason. A caller cannot quote
// what it was not given, however much it wants to be helpful.
//
// ---------------------------------------------------------------------------
// The asymmetry that makes this more than a filter
// ---------------------------------------------------------------------------
//
// The obvious rule would be "an unverified source answers nothing". It is wrong, and
// getting it wrong in that direction would be its own safety failure.
//
//   A STALE HIT IS STILL A HIT. A recall notice does not expire. If we saw it four
//   hours ago and the source has broken since, the notice is still a notice, and
//   withholding a real recall to keep a purity rule would be the worse mistake. It is
//   served, with the time it was last confirmed, and the caller can say so.
//
//   A STALE MISS IS A REFUSAL. "I found nothing" is a different claim entirely, and it
//   is the one that gets someone hurt. A source is unverified here precisely because it
//   failed its contract, and the commonest way to fail it is to return fewer rows than
//   the baseline. Silence from a source that just lost a third of its rows is not
//   evidence of absence. We say we cannot answer, and we say which source and why.
//
// That is the whole idea. Presence survives staleness; absence does not. Every other
// rule in this file follows from it.

import { PUBLISH_THRESHOLD, MATCH_CAVEAT, scoreMatch, type Listing, type MatchBasis } from "./match.js";
import type { PubRecall, Snapshot } from "./snapshot.js";
import { RECALL_SOURCES, type RecallRecord, type RecordState, type RiskLevel, type SourceId } from "./types.js";

/** What we are willing to say about one recall, and where the claim came from.
 *
 *  `vouch` is not optional and has no null case. A record that reaches a caller has a
 *  verification state or it does not reach the caller. */
export interface Vouched {
  sourceId: SourceId;
  sourceLabel: string;
  state: RecordState;
  lastVerifiedAt: string | null;
  /** True when the source is not currently passing its contract. The record is still
   *  served, because a recall does not expire, but the caller is told plainly. */
  stale: boolean;
  /** True for the fixtures built to induce failures. Carried, never inferred from a
   *  name, so nothing downstream can present a fixture as a real notice. */
  synthetic: boolean;
}

export interface AssertedRecall {
  ref: string;
  title: string;
  brand: string | null;
  hazard: string | null;
  risk: RiskLevel;
  action: string | null;
  permalink: string | null;
  published: string | null;
  /** 0 to 1, for the same PRODUCT LINE as the query. Never that a particular unit is
   *  affected; `caveat` on the answer says so in words the caller can pass on. */
  confidence: number;
  basis: MatchBasis;
  /** The tokens the match rests on, so a caller can show its work instead of citing a
   *  number nobody can check. */
  matchedTokens: string[];
  vouch: Vouched;
}

/** Something we looked at and will not assert, as a count and a reason.
 *
 *  Deliberately carries no content. The near-miss is real information and the website
 *  publishes it in full, next to the word "quarantined", where a reader can weigh it.
 *  Handing the same rows to a caller that will summarise them is how a near-miss
 *  becomes an assertion two hops later. A caller that genuinely wants them has to ask
 *  `quarantinedFor` by name, and the name is the disclosure. */
export interface Withholding {
  reason: string;
  count: number;
}

/** Either an assertion or a refusal, and the type does not permit both.
 *
 *  `refusal` non-null means `asserted` is empty. There is a test for that, because it
 *  is the one invariant a caller is entitled to build on. */
export interface ContextAnswer {
  query: string;
  askedAt: string;
  asserted: AssertedRecall[];
  withheld: Withholding[];
  /** Non-null when we will not answer at all. Written to be quoted verbatim. */
  refusal: string | null;
  /** Non-null when we answered, but from at least one source we cannot currently
   *  vouch for. Present alongside an answer rather than instead of it. */
  caution: string | null;
  caveat: string;
}

/** A source we can currently vouch for. `withdrawn` is not in this set: a withdrawn
 *  notice is retained for the record and never presented as an active recall. */
const CURRENT: readonly RecordState[] = ["verified", "healed"];

/** Turn the caller's words into the same object the feed matches listings with.
 *
 *  Reusing `scoreMatch` rather than writing a second, friendlier matcher is the point.
 *  If an agent's answer were scored by a different path than the website's, the two
 *  could disagree about the same product and both would be citing "Vouch". One matcher,
 *  one threshold, one set of reasons. */
function asListing(query: string): Listing {
  return {
    id: "query",
    permalink: null,
    title: query,
    brand: null,
    price: null,
    currency: null,
    condition: null,
    location: null,
    listedOn: null,
  };
}

/** `scoreMatch` wants a RecallRecord; the snapshot holds the published shape. The
 *  fields it reads are the ones a notice is identified by, and they are the same in
 *  both. Building the adapter here keeps the matcher unaware that a published record
 *  exists at all. */
function asRecallRecord(r: PubRecall): RecallRecord {
  return {
    ref: r.ref,
    permalink: r.permalink,
    title: r.title,
    brand: r.brand,
    hazard: r.hazard,
    risk: r.risk,
    category: r.category,
    affectedUnits: r.affectedUnits,
    published: r.published,
    action: r.action,
    provenance: undefined as never,
  };
}

function vouchFor(r: PubRecall): Vouched {
  const p = r.provenance;
  return {
    sourceId: p.sourceId,
    sourceLabel: p.sourceLabel,
    state: p.trust,
    lastVerifiedAt: p.lastVerifiedAt,
    stale: !CURRENT.includes(p.trust),
    synthetic: p.synthetic,
  };
}

function tally(reasons: string[]): Withholding[] {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Recall sources we cannot currently vouch for.
 *
 *  Walks the DECLARED list rather than the snapshot's, so a source that is absent from
 *  the snapshot counts as unvouched instead of counting as nothing. A source disappears
 *  from a build for exactly the reasons that should stop us reporting absence, and a
 *  loop over what happens to be there cannot see the thing that is not. */
function unvouchedSources(snapshot: Snapshot): { id: SourceId; label: string; why: string }[] {
  const out: { id: SourceId; label: string; why: string }[] = [];
  for (const id of RECALL_SOURCES) {
    const s = snapshot.sources.find((x) => x.id === id);
    if (s === undefined) {
      out.push({ id, label: id, why: "the source is missing from this snapshot entirely" });
      continue;
    }
    if (CURRENT.includes(s.trust)) continue;
    out.push({
      id,
      label: s.label,
      why: s.breaches.length > 0 ? s.breaches.join("; ") : `serving ${s.rows} row(s) as ${s.trust}`,
    });
  }
  return out;
}

/**
 * The question a shopping agent actually has: "someone is about to buy this, is it
 * recalled?"
 *
 * Returns an assertion or a refusal, never a blob to interpret.
 */
export function recallContext(
  snapshot: Snapshot,
  query: string,
  now: Date = new Date()
): ContextAnswer {
  const askedAt = now.toISOString();
  const base = { query, askedAt, caveat: MATCH_CAVEAT };
  const trimmed = query.trim();

  if (trimmed.length < 3) {
    return {
      ...base,
      asserted: [],
      withheld: [],
      caution: null,
      refusal: "a product query needs at least three characters to match on",
    };
  }

  const listing = asListing(trimmed);
  const asserted: AssertedRecall[] = [];
  const withheldReasons: string[] = [];

  for (const r of snapshot.recalls) {
    // A withdrawn notice is retained in the feed for the record and is never an active
    // recall. It is not withheld either: reporting "1 record withheld" for a notice the
    // regulator itself retracted would invent a doubt that does not exist.
    if (r.provenance.trust === "withdrawn") continue;

    const m = scoreMatch(asRecallRecord(r), listing);
    if (m === null) continue;

    if (m.contradiction !== null) {
      withheldReasons.push(`the query contradicts the recall: ${m.contradiction}`);
      continue;
    }
    if (!m.publishable || m.confidence < PUBLISH_THRESHOLD) {
      withheldReasons.push(
        `matched on ${m.basis} at ${m.confidence.toFixed(2)}, below the ${PUBLISH_THRESHOLD} bar to assert`
      );
      continue;
    }

    asserted.push({
      ref: r.ref,
      title: r.title,
      brand: r.brand,
      hazard: r.hazard,
      risk: r.risk,
      action: r.action,
      permalink: r.permalink,
      published: r.published,
      confidence: m.confidence,
      basis: m.basis,
      matchedTokens: m.matchedTokens,
      vouch: vouchFor(r),
    });
  }

  // Strongest first. A caller that reads only the first row should read the best one.
  asserted.sort((a, b) => b.confidence - a.confidence || a.ref.localeCompare(b.ref));

  const withheld = tally(withheldReasons);
  const broken = unvouchedSources(snapshot);

  if (asserted.length > 0) {
    // A hit stands whatever the source is doing now: the notice was published, we saw
    // it, and a recall does not stop being one because our scraper broke afterwards.
    // The caution rides alongside so the caller can date the claim rather than drop it.
    const staleHits = asserted.filter((a) => a.vouch.stale);
    const caution =
      staleHits.length === 0
        ? null
        : `${staleHits.length} of ${asserted.length} recall(s) come from a source we cannot ` +
          `currently vouch for (${[...new Set(staleHits.map((a) => a.vouch.sourceLabel))].join(", ")}). ` +
          "The notice itself does not expire, so it is reported with the time it was last " +
          "confirmed rather than withheld.";
    return { ...base, asserted, withheld, caution, refusal: null };
  }

  if (broken.length > 0) {
    // The refusal this module exists for. Absence is the claim we cannot make from a
    // source that just failed its contract, and the commonest failure is losing rows.
    return {
      ...base,
      asserted: [],
      withheld,
      caution: null,
      refusal:
        `no recall matched, but this cannot be reported as "not recalled". ` +
        broken.map((b) => `${b.label} is not currently verified (${b.why})`).join("; ") +
        ". Absence is a claim about everything we did not find, so it is only reportable " +
        "when every recall source is currently passing its contract" +
        // The specific reason, only where it applies. A source that is missing from the
        // snapshot altogether has no row count to have lost, and a refusal that explains
        // itself with the wrong mechanism is worse than one that stops.
        (broken.some((b) => b.why.includes("row count"))
          ? ", and the commonest way to fail one is to return fewer records than the baseline"
          : "") +
        ".",
    };
  }

  return { ...base, asserted: [], withheld, caution: null, refusal: null };
}

/** The near-misses, by request.
 *
 *  Separate from `recallContext` and named for what it does, because the whole reason
 *  quarantine is absent from the default answer is that a caller should not receive it
 *  without having decided to. Asking for it is the disclosure. */
export function quarantinedFor(
  snapshot: Snapshot,
  query: string
): { ref: string; title: string; confidence: number; basis: MatchBasis; reason: string }[] {
  const listing = asListing(query.trim());
  const out: { ref: string; title: string; confidence: number; basis: MatchBasis; reason: string }[] = [];
  for (const r of snapshot.recalls) {
    if (r.provenance.trust === "withdrawn") continue;
    const m = scoreMatch(asRecallRecord(r), listing);
    if (m === null || m.publishable) continue;
    out.push({
      ref: r.ref,
      title: r.title,
      confidence: m.confidence,
      basis: m.basis,
      reason:
        m.contradiction !== null
          ? `contradicted: ${m.contradiction}`
          : `below the ${PUBLISH_THRESHOLD} bar to assert`,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

export interface VouchReport {
  at: string;
  /** True only when every recall source is currently passing its contract. */
  canReportAbsence: boolean;
  sources: {
    id: SourceId;
    label: string;
    kind: "recall" | "listing";
    state: RecordState;
    rows: number;
    lastVerifiedAt: string | null;
    contractPassed: boolean;
    breaches: string[];
    synthetic: boolean;
  }[];
}

/** What the service can and cannot vouch for right now.
 *
 *  A caller that intends to say "not recalled" should read `canReportAbsence` before it
 *  does, and a caller that gets a refusal can read this to find out why without parsing
 *  the sentence it was handed. */
export function vouchReport(snapshot: Snapshot, now: Date = new Date()): VouchReport {
  return {
    at: now.toISOString(),
    canReportAbsence: unvouchedSources(snapshot).length === 0,
    sources: snapshot.sources.map((s) => ({
      id: s.id,
      label: s.label,
      kind: RECALL_SOURCES.includes(s.id) ? "recall" : "listing",
      state: s.trust,
      rows: s.rows,
      lastVerifiedAt: s.lastVerifiedAt,
      contractPassed: s.contractPassed,
      breaches: s.breaches,
      synthetic: s.synthetic,
    })),
  };
}

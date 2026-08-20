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
import type { PubIncident, PubRecall, PubSource, Snapshot } from "./snapshot.js";
import { BASE_COOLDOWN_MS, MAX_COOLDOWN_MS } from "./backoff.js";
import {
  RECALL_SOURCES,
  type RecallRecord,
  type RecordState,
  type RiskLevel,
  type SourceId,
} from "./types.js";

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
  /** The same refusal as something to branch on.
   *
   *  The sentence is for the person the caller is talking to. This is for the caller.
   *  An agent cannot reliably switch on prose, and one that tries will do it by
   *  substring, which breaks the first time the wording improves. Null exactly when
   *  `refusal` is null, and there is a test for the pairing. */
  refusalCode: RefusalCode | null;
  /** Non-null when we answered, but from at least one source we cannot currently
   *  vouch for. Present alongside an answer rather than instead of it. */
  caution: string | null;
  caveat: string;
}

/** Every reason this service declines to answer. A closed set on purpose: a caller is
 *  entitled to enumerate the cases it handles and to fail loudly on one it has not seen,
 *  which is impossible against a free-text field. */
export type RefusalCode =
  /** A recall source is not currently passing its contract, so "nothing found" is not a
   *  claim this data supports. Retry once the source recovers; `breakageReport` says
   *  whether it is expected to and roughly when. */
  | "absence_unverifiable"
  /** The query was too short to match on. Retrying it unchanged will fail again. */
  | "query_too_short";

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
    // Every row wearing this id, not the first one. `find` let a healthy copy answer for
    // a broken one in a snapshot that carried the same source twice, which is the same
    // mistake as trusting a source's own report of itself: the reassuring row is not
    // evidence about the other one.
    const rows = snapshot.sources.filter((x) => x.id === id);
    if (rows.length === 0) {
      out.push({ id, label: id, why: "the source is missing from this snapshot entirely" });
      continue;
    }
    const s = rows.find((x) => !CURRENT.includes(x.trust)) ?? rows[0]!;
    if (!CURRENT.includes(s.trust)) {
      out.push({
        id,
        label: s.label,
        why: s.breaches.length > 0 ? s.breaches.join("; ") : `serving ${s.rows} row(s) as ${s.trust}`,
      });
      continue;
    }
    // Trust alone was not enough, and the gap had a shape worth naming. `deriveTrust`
    // reads the rows a source is serving, and a source refused at the door serves the
    // rows it read last time, which pass the contract because they are the same rows
    // that passed it before. So a blocked source kept `verified` trust with a block
    // incident still open, and this function waved it through: the feed's own breakage
    // report called the source unhealthy while the context service went on licensing
    // "no recall matched" from it. Presence survives that. Absence does not, because
    // being refused is exactly the state in which a new notice would be invisible to us.
    const open = openBreakage(snapshot, id);
    if (open !== null) {
      out.push({
        id,
        label: s.label,
        why: open.evidence.length > 0 ? open.evidence.join("; ") : `an unresolved ${open.cause} incident`,
      });
    }
  }
  return out;
}

/** Causes that mean the source is not currently showing us everything it has.
 *
 *  `gone` is deliberately absent, and so are `healthy` and `resurrected`. A withdrawal
 *  is the system working: the record was removed at source, we established it, we kept
 *  the last-good copy and refused to heal. Nothing about it suggests we lost rows we
 *  should have seen, and counting it would make the service refuse to answer every time
 *  a notice was withdrawn, which is an ordinary event on a recall feed rather than a
 *  failure. A resurrection is not breakage either: the contract passed. */
const BREAKAGE: readonly IncidentCause[] = ["drift", "pagination", "blocked"];

/** Is this incident still describing the present?
 *
 *  `closedAt === null` used to be taken as "still broken", on the reasoning that
 *  incidents are never edited so the open one is the current state. The reasoning has a
 *  gap: an incident is written once, at the moment it is diagnosed, and nothing revisits
 *  it. A repair that was deferred because another was already running on the collector
 *  therefore leaves a record that stays open forever, and `breakage_report` went on
 *  telling callers "the work is in progress" a day after the source had gone green,
 *  while `vouch_report` reported the same source healthy at the same instant. Two tools
 *  contradicting each other about one source is worse than either answer alone.
 *
 *  So an incident is superseded when the source has been verified since it opened and is
 *  currently passing. That is evidence, not an edit: the file in `runs/` is untouched and
 *  still says what it said. All three conditions are required, because dropping any one
 *  of them would let a source that is currently broken look resolved. */
function stillOpen(source: PubSource, incident: PubIncident): boolean {
  if (incident.closedAt !== null) return false;
  if (!source.contractPassed) return true;
  if (!CURRENT.includes(source.trust)) return true;
  const verifiedAt = source.lastVerifiedAt;
  if (verifiedAt === null) return true;
  return verifiedAt <= incident.openedAt;
}

function openBreakage(snapshot: Snapshot, id: SourceId): PubIncident | null {
  const source = snapshot.sources.find((s) => s.id === id);
  if (source === undefined) return null;
  return (
    snapshot.incidents.find(
      (i) => i.sourceId === id && BREAKAGE.includes(i.cause) && stillOpen(source, i)
    ) ?? null
  );
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
  // Strip what a reader cannot see before measuring, for the reason `html.ts` strips it
  // out of page text: a character that renders as nothing is not part of what was said.
  // Three zero-width spaces have length 3 and survive `trim`, so they cleared this gate
  // and came back as a vouched "we looked and found nothing". Nothing was looked for.
  const trimmed = query.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "").trim();

  if (trimmed.length < 3) {
    return {
      ...base,
      asserted: [],
      withheld: [],
      caution: null,
      refusal: "a product query needs at least three characters to match on",
      refusalCode: "query_too_short",
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
    return { ...base, asserted, withheld, caution, refusal: null, refusalCode: null };
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
      refusalCode: "absence_unverifiable",
    };
  }

  return { ...base, asserted: [], withheld, caution: null, refusal: null, refusalCode: null };
}

/** The near-misses, by request.
 *
 *  Separate from `recallContext` and named for what it does, because the whole reason
 *  quarantine is absent from the default answer is that a caller should not receive it
 *  without having decided to. Asking for it is the disclosure. */
export interface QuarantinedRecall {
  ref: string;
  title: string;
  confidence: number;
  basis: MatchBasis;
  reason: string;
  /** The same block the asserted path carries, and for the same reason.
   *
   *  This was absent, and its absence was the sharpest promise break an outside review
   *  found. "Fixtures are always labelled synthetic" held everywhere the output gate
   *  could see, and this tool renders on no page, so a synthetic fixture recall reached
   *  agents with ref, full title, confidence and reason and nothing marking it as a
   *  fixture. Withholding a record is not a reason to say less about where it came from;
   *  if anything it is a reason to say more, because the caller asked for it explicitly. */
  vouch: Vouched;
}

export function quarantinedFor(snapshot: Snapshot, query: string): QuarantinedRecall[] {
  const listing = asListing(query.trim());
  const out: QuarantinedRecall[] = [];
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
      vouch: vouchFor(r),
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** One source as `vouch_report` describes it. Named rather than inline so the wire layer
 *  can build a line for one without depending on the whole report. */
export interface VouchSource {
  id: SourceId;
  label: string;
  kind: "recall" | "listing";
  state: RecordState;
  rows: number;
  lastVerifiedAt: string | null;
  contractPassed: boolean;
  breaches: string[];
  synthetic: boolean;
}

export interface VouchReport {
  at: string;
  /** True only when every recall source is currently passing its contract. */
  canReportAbsence: boolean;
  sources: VouchSource[];
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


// --- breakage, for something that has to decide whether to call again -------
//
// A refusal without a retry policy is an invitation to hammer. An agent told "I cannot
// answer" and nothing else will try again immediately, and again, because trying again
// is the only move it has. So the service says which of the four causes is open, whether
// that cause is one a repair can fix at all, and how long to wait before the answer could
// possibly have changed.
//
// The waits are not invented. A repairable cause waits for the time repairs on THAT
// source have actually taken, taken from the incidents that recorded them. A blocked
// source waits the backoff the engine itself uses. A withdrawal waits forever, because
// nothing is broken and there is nothing to come back.

/** Everything an incident can be about, failures and the two events that are not. */
export type IncidentCause = PubIncident["cause"];

export type RetryAdvice =
  | { retry: false; why: string }
  | { retry: true; afterMs: number; why: string };

export interface SourceBreakage {
  id: SourceId;
  label: string;
  state: RecordState;
  /** The open incident's cause, or null when nothing is open. Wider than the four
   *  failures on purpose: `resurrected` is an open incident and is not a breakage, and a
   *  report that flattened it into one would tell a caller to wait for a repair that is
   *  never coming. */
  cause: IncidentCause | null;
  /** Whether a repair is even permitted for this cause. Two of the four are never
   *  repairable, and that is the project's central claim rather than a tuning choice. */
  healable: boolean;
  openedAt: string | null;
  /** A repair could not start because one was already running on this collector. The
   *  work is happening, it is just not ours. */
  repairDeferred: boolean;
  breaches: string[];
  advice: RetryAdvice;
}

export interface BreakageReport {
  at: string;
  /** True when every source is passing its contract and nothing is open. */
  healthy: boolean;
  /** The one flag a caller must read before saying a product is not recalled. */
  canReportAbsence: boolean;
  sources: SourceBreakage[];
}

/** Causes whose resolution involved a repair running. Everything else that resolves is
 *  an event, and an event resolving tells a caller nothing about how long to wait.
 *
 *  `gone` and `resurrected` are the two that matter here. Both close with `verified:
 *  true` and `mttrMs: 0`, correctly: a withdrawal is the source working and needs no
 *  repair, so no time elapsed between noticing and serving the truth again. Counting
 *  those zeroes as repair durations is what this list exists to stop. */
const REPAIRED: readonly PubIncident["cause"][] = ["drift", "pagination"];

/** How long repairs on this source have actually taken, from the incidents where one
 *  actually ran. The median rather than the mean: a single 900-second outlier should not
 *  tell a caller to wait a quarter of an hour. Null when this source has never had a
 *  repair verified, in which case we have measured nothing and say so instead of
 *  guessing.
 *
 *  The cause filter and the `> 0` are both load-bearing, and their absence shipped. With
 *  every verified incident counted, tradewell's real history of one 347.6-second repair
 *  plus a withdrawal and a resurrection gave a median of zero, so `breakage_report`
 *  advised `RETRY after=0s` while the rest of the engine was saying to back off. A tool
 *  that promises a wait "measured from repairs that actually ran there" cannot answer
 *  with the time a withdrawal took to not need repairing. */
export function measuredRepairMs(incidents: readonly PubIncident[], sourceId: SourceId): number | null {
  const times = incidents
    .filter(
      (i) =>
        i.sourceId === sourceId &&
        i.verified &&
        i.mttrMs !== null &&
        i.mttrMs > 0 &&
        REPAIRED.includes(i.cause)
    )
    .map((i) => i.mttrMs as number)
    .sort((a, b) => a - b);
  if (times.length === 0) return null;
  return times[Math.floor(times.length / 2)] ?? null;
}

/** What a caller should do about one source, given what is open on it. */
export function adviseRetry(
  cause: IncidentCause | null,
  healable: boolean,
  repairDeferred: boolean,
  measuredMs: number | null
): RetryAdvice {
  if (cause === null) return { retry: false, why: "nothing is open on this source" };

  if (cause === "healthy" || cause === "resurrected") {
    // Neither of these is a failure. A resurrection is a withdrawn record back on sale,
    // which is the most actionable thing this feed reports and the least like breakage:
    // the data is current, the answer already reflects it, and there is nothing to wait
    // for.
    return {
      retry: false,
      why:
        cause === "resurrected"
          ? "a withdrawn record is on sale again. The feed already reflects it and nothing is broken"
          : "nothing is wrong with this source",
    };
  }

  if (cause === "gone") {
    // Not a failure. The publisher withdrew the records and the feed agrees with it.
    // Telling a caller to retry would suggest something is coming back.
    return {
      retry: false,
      why: "the records were withdrawn by the publisher, which is not a failure and will not reverse on its own",
    };
  }

  if (cause === "blocked") {
    return {
      retry: true,
      afterMs: BASE_COOLDOWN_MS,
      why:
        `we were served a wall rather than the page. A repair cannot fix being refused, so ` +
        `the source is left alone and the wait doubles each time up to ` +
        `${Math.round(MAX_COOLDOWN_MS / 60_000)} minutes`,
    };
  }

  // drift and pagination: repairable, and the wait is however long a repair here takes.
  if (!healable) {
    return { retry: false, why: `${cause} was diagnosed but the repair was refused, so nothing is in progress` };
  }
  if (repairDeferred) {
    return {
      retry: true,
      afterMs: measuredMs ?? BASE_COOLDOWN_MS,
      why: "a repair was already running on this collector, so ours did not start. The work is in progress",
    };
  }
  return measuredMs === null
    ? {
        retry: true,
        afterMs: BASE_COOLDOWN_MS,
        why: `${cause} is repairable, but no repair on this source has been verified yet, so there is no measured time to quote`,
      }
    : {
        retry: true,
        afterMs: measuredMs,
        why: `${cause} is repairable, and repairs on this source have taken ${Math.round(measuredMs / 1000)}s`,
      };
}

export function breakageReport(snapshot: Snapshot, now: Date = new Date()): BreakageReport {
  const sources = snapshot.sources.map((s): SourceBreakage => {
    // The newest incident still describing this source's present. See `stillOpen`: an
    // unclosed record is not the same thing as a source that is still broken.
    const open = snapshot.incidents
      .filter((i) => i.sourceId === s.id && stillOpen(s, i))
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];

    const cause = open?.cause ?? null;
    const healable = open?.healable ?? false;
    const repairDeferred = open?.healDeferred ?? false;
    return {
      id: s.id,
      label: s.label,
      state: s.trust,
      cause,
      healable,
      openedAt: open?.openedAt ?? null,
      repairDeferred,
      breaches: s.breaches,
      advice: adviseRetry(cause, healable, repairDeferred, measuredRepairMs(snapshot.incidents, s.id)),
    };
  });

  return {
    at: now.toISOString(),
    // `every` is vacuously true on an empty list, and a build that lost every source
    // reported perfect health. Being vacuous in the reassuring direction is the failure
    // mode that matters: a caller reading `healthy` has no reason to look further.
    healthy: sources.length > 0 && sources.every((x) => x.cause === null && CURRENT.includes(x.state)),
    canReportAbsence: unvouchedSources(snapshot).length === 0,
    sources,
  };
}

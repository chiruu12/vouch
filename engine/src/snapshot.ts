// What the feed is allowed to publish, assembled from what the engine measured.
//
// The web app does not scrape. It renders a snapshot that this file produces from
// state the supervision cycle wrote, and that separation is deliberate rather than a
// convenience: a page that scrapes on request cannot tell a reader when the data was
// last verified, because the answer would be "just now, unverified". Trust state is a
// property of a completed cycle, so the cycle publishes and the page renders.
//
// Two rules are enforced here rather than trusted to the templates:
//
//   1. Seller identity never reaches the snapshot. Listings carry `sellerKey`, an
//      opaque hash used to de-duplicate, and even that is stripped on the way out.
//      A template that forgot would leak; a serialiser that cannot emit the field
//      cannot leak. See docs/decisions.md §7 and snapshot.test.ts.
//   2. Every published record carries its trust state, contract version and the time
//      of the last probe that satisfied that contract. There is no code path that
//      emits a record without them, because the type has no optional provenance.
//
//   node --import tsx src/snapshot.ts        # writes web/public/snapshot.json

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkContract, ARCADIA_CONTRACT, type SourceContract } from "./contract.js";
import { MATCH_CAVEAT, PUBLISH_THRESHOLD, matchListings, type Listing, type Match } from "./match.js";
import { normaliseCpsc, CPSC_CONTRACT } from "./sources/cpsc.js";
import { normaliseEbay } from "./sources/ebay.js";
import { TRADEWELL_CONTRACT } from "./sources/tradewell.js";
import type { Incident, SourceState } from "./runner.js";
import type { RecallRecord, RecordState, RiskLevel, SourceId } from "./types.js";

// --- the published shape ---------------------------------------------------

/** Where a record came from and what we are willing to say about it. Not optional
 *  anywhere in this file: a record without provenance is not publishable. */
export interface PubProvenance {
  sourceId: SourceId;
  sourceLabel: string;
  /** True when a Bright Data collector produced this. False when the publisher
   *  already offers machine-readable data, which is a different reliability claim
   *  and is stated as such rather than blurred. */
  scraped: boolean;
  /** True for the fixtures we built to induce failures on demand. Carried as a flag
   *  rather than left implicit in the label, so the feed cannot accidentally present
   *  a fixture record as a real one and no template has to parse a name to find out. */
  synthetic: boolean;
  contractVersion: string;
  trust: RecordState;
  fetchedAt: string;
  lastVerifiedAt: string | null;
  /** Number of verified heals behind this record's current shape. */
  heals: number;
}

export interface PubListing {
  id: string;
  permalink: string | null;
  title: string;
  brand: string | null;
  price: number | null;
  currency: string | null;
  condition: string | null;
  location: string | null;
  listedOn: string | null;
  provenance: PubProvenance;
  /** Present when this listing was published as withdrawn and is on sale again.
   *
   *  A recalled product returning to sale is the most actionable event this feed can
   *  report, and until now it was reported only in the incident log while the listing
   *  itself went back to looking like any other. Both dates come from the incidents
   *  that recorded them, so the claim is checkable against the log. */
  resurrected?: { withdrawnAt: string; backOnSaleAt: string };
  /** Present when this listing was matched to a recall. */
  match?: {
    confidence: number;
    basis: Match["basis"];
    matchedTokens: string[];
    contradiction: string | null;
    publishable: boolean;
  };
}

export interface PubRecall {
  ref: string;
  permalink: string | null;
  title: string;
  brand: string | null;
  hazard: string | null;
  risk: RiskLevel;
  category: string | null;
  affectedUnits: string | null;
  published: string | null;
  action: string | null;
  provenance: PubProvenance;
  /** Listings we are willing to assert are the same product line as this recall. */
  onSale: PubListing[];
  /** Listings that looked close but did not clear the bar, kept visible with the
   *  reason. Quarantine is published because a silently dropped near-miss is
   *  indistinguishable from a system that never looked. */
  quarantined: PubListing[];
}

export interface PubSource {
  id: SourceId;
  label: string;
  scraped: boolean;
  synthetic: boolean;
  collectorId: string | null;
  url: string;
  contractVersion: string;
  /** Result of the most recent cycle. */
  trust: RecordState;
  rows: number;
  baselineRows: number | null;
  contractPassed: boolean;
  breaches: string[];
  lastVerifiedAt: string | null;
  withdrawnRefs: string[];
  heals: number;
}

export interface PubIncident {
  id: string;
  sourceId: SourceId;
  sourceLabel: string;
  openedAt: string;
  closedAt: string | null;
  cause: Incident["cause"];
  healable: boolean;
  /** Verbatim. These are the sentences the classifier wrote at the time, and they
   *  are rendered unedited: a summary of our own evidence is not evidence. */
  evidence: string[];
  refusal: string | null;
  healAttempted: boolean;
  /** The repair was not refused, it was not allowed to start yet. */
  healDeferred: boolean;
  healDurationMs: number | null;
  /** The synthesised prompt, shown in full when we did heal. */
  prompt: string | null;
  verified: boolean;
  mttrMs: number | null;
  withdrawnRefs: string[];
  /** Refs published as withdrawn that the source is offering again. */
  resurrectedRefs: string[];
  rows: number;
  breaches: string[];
}

/** The scale measurement. Six recalls against fourteen fixture listings proves the
 *  wiring; it does not tell you what the matcher does against a real marketplace.
 *  This block is that number, taken once, on a real capture, and reported whole. */
export interface PubStudy {
  recallSource: string;
  listingSource: string;
  capturedAt: string;
  recalls: number;
  listings: number;
  publishThreshold: number;
  matched: number;
  publishable: number;
  quarantined: number;
  unmatched: number;
  byBasis: { basis: string; count: number }[];
  /** Why each quarantined listing was held back, grouped. */
  quarantineReasons: { reason: string; count: number }[];
  examples: {
    verdict: "publishable" | "quarantined";
    recallRef: string;
    recallTitle: string;
    listingTitle: string;
    confidence: number;
    basis: string;
    matchedTokens: string[];
    contradiction: string | null;
  }[];
}

export interface Snapshot {
  generatedAt: string;
  caveat: string;
  publishThreshold: number;
  sources: PubSource[];
  recalls: PubRecall[];
  /** Listings whose record we keep after the marketplace removed them. Never shown
   *  as available, never regenerated. */
  withdrawn: PubListing[];
  incidents: PubIncident[];
  study: PubStudy;
  totals: {
    recalls: number;
    listingsWatched: number;
    asserted: number;
    quarantined: number;
    withdrawn: number;
    refusals: number;
  };
}

// --- assembling it ---------------------------------------------------------

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const load = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

/** Strip everything the published shape does not name. `sellerKey` is the field this
 *  exists for: it is useful inside the pipeline and must not leave it. */
/** A link we are willing to put under a trust pill.
 *
 *  The permalink a reader clicks was scraped, or written by a healer, and until now
 *  nothing checked it: the adapter took any string, the contract asked only for twenty
 *  characters, and the page rendered it inside an anchor beneath a "verified" label.
 *  Meanwhile the withdrawal oracle probes a URL it builds from the ref, so "we probed
 *  the permalink" described a URL the feed does not publish.
 *
 *  A lookalike host passes every one of those checks. `tradewell-market.vercel.app` and
 *  `tradewell-market.vercel.app.phish-example.invalid` differ by a suffix and are
 *  entirely different sites, so the test is exact host equality against the source we
 *  actually scraped, not a prefix or a contains.
 *
 *  A link that fails becomes null rather than failing the build. The listing is still
 *  worth publishing, and a recall match with no link is a smaller loss than a recall
 *  match pointing somewhere we cannot vouch for. */
export function samePlaceWeScraped(permalink: string | null, sourceUrl: string): string | null {
  if (permalink === null) return null;
  try {
    const link = new URL(permalink);
    // Anything that is not ordinary web traffic is out before hosts are compared, so
    // javascript: and data: cannot reach a template and rely on the framework to catch
    // them. React happens to block javascript: hrefs; that is React protecting us,
    // which is not the same as this project being careful.
    if (link.protocol !== "https:" && link.protocol !== "http:") return null;
    return link.host === new URL(sourceUrl).host ? permalink : null;
  } catch {
    return null;
  }
}

function publishListing(
  l: Listing,
  provenance: PubProvenance,
  match?: Match,
  resurrected?: PubListing["resurrected"]
): PubListing {
  const sourceUrl = META[provenance.sourceId]?.url ?? "";
  const out: PubListing = {
    id: l.id,
    permalink: samePlaceWeScraped(l.permalink, sourceUrl),
    title: l.title,
    brand: l.brand,
    price: l.price,
    currency: l.currency,
    condition: l.condition,
    location: l.location,
    listedOn: l.listedOn,
    provenance,
  };
  if (resurrected !== undefined) out.resurrected = resurrected;
  if (match !== undefined) {
    out.match = {
      confidence: match.confidence,
      basis: match.basis,
      matchedTokens: match.matchedTokens,
      contradiction: match.contradiction,
      publishable: match.publishable,
    };
  }
  return out;
}

function readState(sourceId: string): SourceState | null {
  try {
    return JSON.parse(readFileSync(join(ROOT, "runs", `state-${sourceId}.json`), "utf8")) as SourceState;
  } catch {
    return null;
  }
}

interface SourceMeta {
  label: string;
  scraped: boolean;
  collectorId: string | null;
  url: string;
  contract: SourceContract;
  synthetic: boolean;
  /** When this source has no live supervision state, the moment its data was actually
   *  captured. Without it the feed reports "last verified never", which is both wrong
   *  and the exact kind of vague provenance the project is against. */
  capturedAt?: string;
}

const META: Record<string, SourceMeta> = {
  cpsc: {
    label: "US CPSC (captured sample)",
    // CPSC publishes a JSON API. Saying we scraped it would overstate the difficulty
    // and understate the reliability, so the feed distinguishes the two.
    scraped: false,
    collectorId: null,
    url: "https://www.saferproducts.gov/RestWebServices/Recall",
    contract: CPSC_CONTRACT,
    synthetic: false,
    // Pulled once from the live API and committed so the tests and the feed run
    // offline. Stamped rather than implied, because a captured sample that presents
    // itself as current is exactly the failure this project is about.
    capturedAt: "2026-08-17T13:13:32.000Z",
  },
  arcadia: {
    label: "Arcadia Product Safety (synthetic)",
    scraped: true,
    collectorId: "c_msx7z3xi2hs08ccwms",
    url: "https://arcadia-safety.vercel.app/",
    contract: ARCADIA_CONTRACT,
    synthetic: true,
  },
  tradewell: {
    label: "Tradewell Market (synthetic)",
    scraped: true,
    collectorId: "c_msxhnjyoflutq9tt8",
    url: "https://tradewell-market.vercel.app/",
    contract: TRADEWELL_CONTRACT,
    synthetic: true,
  },
};

/** What we are willing to say about a source's records right now.
 *
 *  One function, because the feed has already been caught saying two things at once.
 *  The health strip derived this properly while every record under it was handed the
 *  literal string "verified", so during a degraded cycle the strip read FAIL and the
 *  listings beneath it read verified. That is the same bug the card's own comment
 *  describes fixing, fixed on the card and left standing one component down.
 *
 *  A volume breach with recorded withdrawals behind it does not un-verify rows that were
 *  read cleanly: the classifier established that every missing record 404s and that no
 *  field breached, so the survivors are still vouched for. A field breach is different
 *  and does un-verify them, because it means we misread what we did fetch. */
export function deriveTrust(sourceId: SourceId, rows: readonly unknown[], state: SourceState | null): RecordState {
  const meta = META[sourceId];
  if (meta === undefined) throw new Error(`no metadata for source ${sourceId}`);
  const report = checkContract(meta.contract, rows as Record<string, unknown>[], state?.baselineRows ?? null);
  const volumeOnly = report.breaches.length > 0 && report.fields.every((f) => !f.breached);
  const explainedByWithdrawal = volumeOnly && (state?.withdrawnRefs.length ?? 0) > 0;
  if (!(report.passed || explainedByWithdrawal)) return "unverified";
  return (state?.healHistory.some((h) => h.verified) ?? false) ? "healed" : "verified";
}

function provenanceFor(sourceId: SourceId, state: SourceState | null, trust: RecordState): PubProvenance {
  const meta = META[sourceId];
  if (meta === undefined) throw new Error(`no metadata for source ${sourceId}`);
  const at = state?.lastVerifiedAt ?? meta.capturedAt ?? null;
  if (at === null) {
    // Better to fail the build than to publish a record whose age nobody can state.
    // The state files are committed, so in practice this fires only when one has been
    // deleted, and the message says how to get it back rather than just what is wrong.
    throw new Error(
      `source ${sourceId} has neither supervision state nor a capture time.\n` +
        `  runs/state-${sourceId}.json is missing. Either restore it from git:\n` +
        `    git checkout runs/state-${sourceId}.json\n` +
        `  or run a cycle to produce a fresh one (needs BRIGHTDATA_API_KEY):\n` +
        `    node --import tsx src/cycle.ts ${sourceId}`
    );
  }
  return {
    sourceId,
    sourceLabel: meta.label,
    scraped: meta.scraped,
    synthetic: meta.synthetic,
    contractVersion: meta.contract.version,
    trust,
    fetchedAt: at,
    lastVerifiedAt: at,
    heals: state?.healHistory.filter((h) => h.verified).length ?? 0,
  };
}

/** Verified repairs on this source, counted from the published incident log rather
 *  than from the state file.
 *
 *  The state file only knows about the collector it belongs to. The repair this project
 *  quotes its MTTR from ran on a third collector against a preview deployment, and that
 *  collector's state is not committed, so every source card said "0 verified heals"
 *  while the incident log two clicks away described a repair that took 330.6s and was
 *  served. The feed was under-reporting its own strongest evidence. Incidents are the
 *  published record, so they are what the count should come from. */
function verifiedHeals(sourceId: SourceId, incidents: readonly PubIncident[]): number {
  return incidents.filter((i) => i.sourceId === sourceId && i.healAttempted && i.verified).length;
}

function sourceCard(
  sourceId: SourceId,
  state: SourceState | null,
  rows: readonly object[],
  incidents: readonly PubIncident[]
): PubSource {
  const meta = META[sourceId];
  if (meta === undefined) throw new Error(`no metadata for source ${sourceId}`);
  const report = checkContract(meta.contract, rows, state?.baselineRows ?? null);

  // A withdrawal lowers a source's volume legitimately, and the contract cannot tell
  // that from a scraper losing rows: both look like the count going down. The runner
  // can, because the classifier established that every missing record 404s and that no
  // field breached, and on that basis it vouches for the survivors.
  //
  // This card used to re-derive trust from a fresh contract run and reach the opposite
  // answer, so the feed could label every record verified while its own health strip
  // called the source unverified. Two true statements, one word doing both jobs. The
  // card now applies the runner's reasoning: a volume breach with recorded withdrawals
  // behind it does not un-verify rows that were read cleanly. A field breach still does,
  // and the breach text is published either way so the reader sees the number regardless.
  return {
    id: sourceId,
    label: meta.label,
    scraped: meta.scraped,
    synthetic: meta.synthetic,
    collectorId: meta.collectorId,
    url: meta.url,
    contractVersion: meta.contract.version,
    trust: deriveTrust(sourceId, rows, state),
    rows: rows.length,
    baselineRows: state?.baselineRows ?? null,
    contractPassed: report.passed,
    breaches: report.breaches,
    lastVerifiedAt: state?.lastVerifiedAt ?? meta.capturedAt ?? null,
    withdrawnRefs: state?.withdrawnRefs ?? [],
    heals: Math.max(
      state?.healHistory.filter((h) => h.verified).length ?? 0,
      verifiedHeals(sourceId, incidents)
    ),
  };
}

/** Incidents as the cycle wrote them, oldest first. Includes the ones caused by our
 *  own mistakes: an incident log that only records the source's failures is a
 *  marketing page. See README on incident 1. */
function loadIncidents(): PubIncident[] {
  let files: string[];
  try {
    files = readdirSync(join(ROOT, "runs")).filter((f) => f.startsWith("incident-") && f.endsWith(".json"));
  } catch {
    return [];
  }

  const out: PubIncident[] = [];
  for (const f of files) {
    const raw = load(join("runs", f)) as {
      incident: Incident;
      report: { rows: number; breaches: string[] };
      diagnosis: { healable: boolean; evidence: string[] };
    };
    const sourceId = raw.incident.sourceId;
    out.push({
      id: f.replace(/^incident-|\.json$/g, ""),
      sourceId,
      sourceLabel: META[sourceId]?.label ?? sourceId,
      openedAt: raw.incident.openedAt,
      closedAt: raw.incident.closedAt,
      cause: raw.incident.cause,
      healable: raw.diagnosis.healable,
      // The incident's own evidence, falling back to the diagnosis it came from.
      //
      // These are the same list for every failure, because the runner copies the
      // diagnosis into the incident. They are not the same for a resurrection: nothing
      // failed, so the diagnosis is `healthy` and carries no evidence, while the
      // incident carries the three lines that say a withdrawn record is on sale again.
      // Reading only the diagnosis published an empty evidence block for the one event
      // the feed ranks above every other, which is the event a reader most needs the
      // reasoning for.
      evidence:
        raw.incident.evidence !== undefined && raw.incident.evidence.length > 0
          ? raw.incident.evidence
          : raw.diagnosis.evidence,
      refusal: raw.incident.refusal,
      healAttempted: raw.incident.healAttempted,
      healDeferred: raw.incident.healDeferred ?? false,
      healDurationMs: raw.incident.healDurationMs,
      prompt: raw.incident.prompt,
      verified: raw.incident.verified,
      mttrMs: raw.incident.mttrMs,
      withdrawnRefs: raw.incident.withdrawnRefs,
      resurrectedRefs: raw.incident.resurrectedRefs ?? [],
      rows: raw.report.rows,
      breaches: raw.report.breaches,
    });
  }
  // By when it happened, not by filename. Filenames carry the state key as well as the
  // timestamp, so sorting them put every incident from one collector before every
  // incident from another regardless of order, and the page claims to be a timeline.
  return out.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

/** Take up to `n` items, preferring one per distinct key before repeating any key. */
function spread<T>(items: readonly T[], keyOf: (t: T) => string, n: number): T[] {
  const seen = new Set<string>();
  const first: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    const k = keyOf(item);
    if (seen.has(k)) rest.push(item);
    else {
      seen.add(k);
      first.push(item);
    }
  }
  return [...first, ...rest].slice(0, n);
}

function buildStudy(recalls: readonly RecallRecord[], listings: readonly Listing[]): PubStudy {
  const matches = matchListings(recalls, listings);
  const byRef = new Map(recalls.map((r) => [r.ref, r]));
  const byId = new Map(listings.map((l) => [l.id, l]));

  const basis = new Map<string, number>();
  for (const m of matches) basis.set(m.basis, (basis.get(m.basis) ?? 0) + 1);

  // Group quarantine reasons rather than listing 168 near-identical lines. The
  // contradiction text already states the clash, so it groups naturally.
  const reasons = new Map<string, number>();
  for (const m of matches.filter((x) => !x.publishable)) {
    const reason =
      m.contradiction !== null
        ? m.contradiction
        : `confidence ${m.confidence.toFixed(2)} on ${m.basis} is below the ${PUBLISH_THRESHOLD} threshold`;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  const example = (m: Match) => ({
    verdict: (m.publishable ? "publishable" : "quarantined") as "publishable" | "quarantined",
    recallRef: m.recallRef,
    recallTitle: byRef.get(m.recallRef)?.title ?? m.recallRef,
    listingTitle: byId.get(m.listingId)?.title ?? m.listingId,
    confidence: m.confidence,
    basis: m.basis,
    matchedTokens: m.matchedTokens,
    contradiction: m.contradiction,
  });

  return {
    recallSource: "US CPSC recall API (real)",
    listingSource: "eBay search results via Bright Data Scraper Studio (real)",
    capturedAt: "2026-08-17",
    recalls: recalls.length,
    listings: listings.length,
    publishThreshold: PUBLISH_THRESHOLD,
    matched: matches.length,
    publishable: matches.filter((m) => m.publishable).length,
    quarantined: matches.filter((m) => !m.publishable).length,
    unmatched: listings.length - matches.length,
    byBasis: [...basis.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([b, count]) => ({ basis: b, count })),
    quarantineReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count })),
    // Spread the examples across distinct recalls and distinct hold-back reasons.
    // Taking the first four of each gave eight rows about one recall and one clash,
    // which showed the reader the matcher works on Cooluli fridges rather than what
    // the matcher does.
    examples: [
      ...spread(matches.filter((m) => m.publishable), (m) => m.recallRef, 4),
      ...spread(
        matches.filter((m) => !m.publishable),
        (m) => m.contradiction ?? m.basis,
        4
      ),
    ].map(example),
  };
}

export function buildSnapshot(now = new Date()): Snapshot {
  // --- recalls. CPSC is real and published; arcadia is the scraped fixture. -----
  const cpscState = readState("cpsc");
  const cpscRows = normaliseCpsc(load("engine/test/fixtures/cpsc-sample.json"));
  const cpscProv = provenanceFor("cpsc", cpscState, "verified");
  const cpscRecalls: RecallRecord[] = cpscRows.map((c) => ({ ...c, provenance: cpscProv as never }));

  const arcadiaState = readState("arcadia");
  const arcadiaRows = (arcadiaState?.lastGoodRows ?? []) as unknown as Omit<RecallRecord, "provenance">[];
  const arcadiaProv = provenanceFor("arcadia", arcadiaState, deriveTrust("arcadia", arcadiaRows, arcadiaState));

  // --- the marketplace we supervise -------------------------------------------
  const twState = readState("tradewell");
  const withdrawnRefs = new Set(twState?.withdrawnRefs ?? []);

  // A withdrawn record should never be in lastGoodRows: the supervisor strips it from
  // the fallback, and a repair that hands one back is discarded before it can be
  // promoted. This filter does not restate that, it refuses to take its word for it.
  // The publish boundary is where a phantom stops being a bad row and becomes a live
  // safety claim about a product someone might buy, so it is worth a second lock. A
  // bug that put a confirmed-withdrawn record back into lastGoodRows during an
  // unrelated repair is exactly how the first lock failed.
  const twLive = ((twState?.lastGoodRows ?? []) as unknown as Listing[]).filter(
    (l) => !withdrawnRefs.has(String(l.id))
  );
  const twProv = provenanceFor("tradewell", twState, deriveTrust("tradewell", twLive, twState));

  // Withdrawn listings are not in lastGoodRows any more, by design. Their text comes
  // from the baseline capture, and they are republished only as a withdrawal record.
  const twBaseline = JSON.parse(
    readFileSync(join(ROOT, "engine", "samples", "tradewell-baseline.json"), "utf8")
  ) as unknown;
  const twBaselineListings: Listing[] = (() => {
    // Local import avoids a cycle at module load and keeps the adapter authoritative.
    const rows = Array.isArray(twBaseline) ? twBaseline : [];
    const flat: Record<string, unknown>[] = [];
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      if (Array.isArray(row.results)) flat.push(...(row.results as Record<string, unknown>[]));
      else flat.push(row);
    }
    return flat.map((r) => ({
      id: String(r.item_id ?? r.id ?? ""),
      permalink: typeof r.url === "string" ? r.url : null,
      title: String(r.title ?? ""),
      brand: typeof r.brand === "string" ? r.brand : null,
      price: typeof r.price === "number" ? r.price : null,
      currency: null,
      condition: typeof r.condition === "string" ? r.condition : null,
      location: typeof r.location === "string" ? r.location : null,
      listedOn: typeof r.listed === "string" ? r.listed : null,
    }));
  })();

  const withdrawnProv = provenanceFor("tradewell", twState, "withdrawn");

  // --- match the recalls we hold against the marketplace we supervise ----------
  const allRecalls: RecallRecord[] = [
    ...cpscRecalls,
    ...arcadiaRows.map((r) => ({ ...r, provenance: arcadiaProv as never })),
  ];
  const matches = matchListings(allRecalls, twLive);
  const byListing = new Map(twLive.map((l) => [l.id, l]));

  // Both halves of a resurrection come from the incident log rather than from a flag we
  // set here, so what the feed says about a record is checkable against the record of
  // why it says it. A ref with a return but no recorded withdrawal is skipped: we would
  // be asserting a history we cannot show.
  const incidents = loadIncidents();
  const backOnSale = new Map<string, PubListing["resurrected"]>();
  for (const i of incidents) {
    for (const ref of i.resurrectedRefs) {
      const gone = incidents.find(
        (j) => j.withdrawnRefs.includes(ref) && j.openedAt <= i.openedAt
      );
      if (gone !== undefined) {
        backOnSale.set(ref, { withdrawnAt: gone.openedAt, backOnSaleAt: i.openedAt });
      }
    }
  }

  const recalls: PubRecall[] = allRecalls.map((r) => {
    const mine = matches.filter((m) => m.recallRef === r.ref);
    const toPub = (m: Match): PubListing | null => {
      const l = byListing.get(m.listingId);
      return l === undefined ? null : publishListing(l, twProv, m, backOnSale.get(m.listingId));
    };
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
      provenance: r.provenance as unknown as PubProvenance,
      onSale: mine.filter((m) => m.publishable).map(toPub).filter((x): x is PubListing => x !== null),
      quarantined: mine.filter((m) => !m.publishable).map(toPub).filter((x): x is PubListing => x !== null),
    };
  });

  // Withdrawn records keep their match, because "this recalled product was listed
  // here and the listing is now gone" is the useful statement, not "some id vanished".
  const baselineMatches = matchListings(allRecalls, twBaselineListings);
  const withdrawn: PubListing[] = twBaselineListings
    .filter((l) => withdrawnRefs.has(l.id))
    .map((l) => {
      const m = baselineMatches.find((x) => x.listingId === l.id);
      return m === undefined ? publishListing(l, withdrawnProv) : publishListing(l, withdrawnProv, m);
    });

  const study = buildStudy(cpscRecalls, normaliseEbay(load("engine/samples/ebay-cooluli-minifridge.json")));

  const sources: PubSource[] = [
    sourceCard("cpsc", cpscState, cpscRows, incidents),
    sourceCard("arcadia", arcadiaState, arcadiaRows, incidents),
    sourceCard("tradewell", twState, twLive as unknown as object[], incidents),
  ];

  return {
    generatedAt: now.toISOString(),
    caveat: MATCH_CAVEAT,
    publishThreshold: PUBLISH_THRESHOLD,
    sources,
    recalls,
    withdrawn,
    incidents,
    study,
    totals: {
      recalls: recalls.length,
      listingsWatched: twLive.length,
      asserted: recalls.reduce((n, r) => n + r.onSale.length, 0),
      quarantined: recalls.reduce((n, r) => n + r.quarantined.length, 0),
      withdrawn: withdrawn.length,
      // A deferral carries a refusal string but is not one: the repair was not declined,
      // it was not allowed to start. Counting it here would inflate the one number the
      // whole project is judged on, which is the last place to be loose.
      refusals: incidents.filter((i) => i.refusal !== null && !i.healDeferred).length,
    },
  };
}

// --- cli -------------------------------------------------------------------

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && entry.endsWith("snapshot.ts");
}

if (isMain()) {
  const snap = buildSnapshot();
  const out = join(ROOT, "web", "public", "snapshot.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snap, null, 2) + "\n");

  console.log(`wrote ${out}`);
  console.log("");
  for (const s of snap.sources) {
    console.log(
      `  ${s.label.padEnd(34)} ${s.trust.padEnd(11)} ${String(s.rows).padStart(3)} rows` +
        `  contract ${s.contractPassed ? "pass" : "FAIL"}` +
        (s.withdrawnRefs.length > 0 ? `  ${s.withdrawnRefs.length} withdrawn` : "")
    );
  }
  console.log("");
  console.log(`  recalls           ${snap.totals.recalls}`);
  console.log(`  listings watched  ${snap.totals.listingsWatched}`);
  console.log(`  asserted matches  ${snap.totals.asserted}`);
  console.log(`  quarantined       ${snap.totals.quarantined}`);
  console.log(`  withdrawn         ${snap.totals.withdrawn}`);
  console.log(`  incidents         ${snap.incidents.length} (${snap.totals.refusals} with a refusal)`);
  console.log("");
  console.log(
    `  study: ${snap.study.publishable} publishable of ${snap.study.listings} real listings, ` +
      `${snap.study.quarantined} quarantined, ${snap.study.unmatched} no match`
  );
}

// Why did this source stop producing good data?
//
// This is the file the project exists for. Every self-healing scraper treats a
// missing field as one problem with one answer: find it again. In a safety-recall
// feed there are four causes and two of them must never be repaired.
//
//   blocked     refused at the door (403, 429, challenge page). Healing rewrites
//               selectors, which does nothing about being blocked, and burns
//               credits pretending otherwise.
//   gone        the notice was withdrawn and its permalink no longer resolves.
//               Heal here and the AI dutifully finds *something* to fill the gap,
//               and we republish a phantom safety recall. This is the failure the
//               whole project is built to prevent.
//   pagination  the listing is intact, the paging scheme moved, we are seeing a
//               slice of it. Repairable.
//   drift       the data is still published in a different shape. Repairable.
//
// Reconciliation against the last good run happens whether or not the contract
// passed. A single withdrawal will not trip a row-count threshold, but we still
// need to record it as withdrawn rather than quietly keep serving it as active.

import type { FailureCause } from "./types.js";
import type { ContractReport } from "./contract.js";

/** Result of fetching the listing page itself, before any extraction. */
export interface ListingProbe {
  status: number;
  bodyBytes: number;
  /** A recognisable challenge or block signature in the body, if any. */
  blockSignature: string | null;
  /** Raw body, when the caller kept it. Used to observe the live markup for the
   *  heal prompt; the classifier itself only needs status and signature. */
  body?: string;
}

export interface PermalinkProbe {
  ref: string;
  status: number;
  /** A phrase in the body that says the record is gone, on a response that did not
   *  say so in its status. Set by the probe, checked here, for the same reason
   *  `blockSignature` exists: the dangerous case is the one that does not announce
   *  itself in the status line. */
  goneSignature?: string | null;
}

export interface ClassifyInput {
  report: ContractReport;
  listing: ListingProbe;
  /** Refs from the most recent run that satisfied the contract. Empty on first run. */
  baselineRefs: readonly string[];
  /** Refs extracted by the run being judged. */
  currentRefs: readonly string[];
  /** Permalink probes for refs that vanished since the baseline. */
  permalinks: readonly PermalinkProbe[];
  /** Rows one full page yields when healthy. Lets us recognise "we only got page 1". */
  rowsPerPage?: number;
}

export interface Diagnosis {
  cause: FailureCause | "healthy";
  /** Refs the regulator has withdrawn. Preserved as last-good, marked withdrawn,
   *  and never sent to heal. */
  withdrawnRefs: string[];
  /** Refs that vanished while their permalink still resolves. These are genuine
   *  extraction losses and are the reason to heal. */
  lostRefs: string[];
  /** Refs whose permalink could not be reached at all, so nothing can be concluded
   *  about them. Non-empty means no repair may run: repairing asserts the records are
   *  still published, and that is exactly what we failed to establish. */
  unresolvedRefs: string[];
  /** Should the engine call `bdata scraper heal`? */
  healable: boolean;
  /** Ordered statements, quoted verbatim into the heal prompt and the timeline. */
  evidence: string[];
}

/** Statuses that mean "we were refused", not "the content changed". */
const BLOCK_STATUSES = new Set([401, 403, 407, 429, 451, 503]);
/** Statuses that mean a specific document is no longer published. */
const WITHDRAWN_STATUSES = new Set([404, 410]);

export function classify(input: ClassifyInput): Diagnosis {
  const { report, listing, baselineRefs, currentRefs, permalinks } = input;
  const evidence: string[] = [];

  const current = new Set(currentRefs);
  const missing = baselineRefs.filter((r) => !current.has(r));

  const probeByRef = new Map(permalinks.map((p) => [p.ref, p]));

  // A withdrawal is a 404, a 410, or a 200 whose body says the record is gone.
  //
  // For a long time this was status-only while block detection was body-aware, which
  // put the weaker detector on the case the project exists to defend. Plenty of sites
  // answer 200 with a "no longer available" page for a removed record, and such a ref
  // fell through to `lost`, then to `drift`, then got healed: a record deliberately
  // taken down, replaced with fabricated data, silently, with no incident. That is the
  // exact failure this file was written to prevent, reached through a different door.
  const withdrawnRefs = missing.filter((r) => {
    const p = probeByRef.get(r);
    if (p === undefined) return false;
    return WITHDRAWN_STATUSES.has(p.status) || (p.status === 200 && (p.goneSignature ?? null) !== null);
  });

  // The oracle did not answer. A transport failure, a timeout, or a 5xx tells us
  // nothing about whether the record still exists, and "nothing" is not evidence of
  // presence. These refs are neither withdrawn nor lost, and while any of them are
  // outstanding no repair may run: repairing requires establishing that the missing
  // records are still published, and we just failed to establish it.
  // An allowlist, deliberately. This started as a blocklist naming the statuses we had
  // been bitten by, and a property test immediately produced a permalink answering 418
  // that fell straight through it into `lost`, which is the verdict that authorises a
  // repair. Enumerating the bad cases means the next status nobody thought of is
  // treated as evidence the record is still published.
  //
  // So: exactly one response means "still there", a clean 200 with nothing in the body
  // saying otherwise. Withdrawal signals are handled above. Everything else, whatever it
  // is, means we could not establish anything, and nothing is repaired until we can.
  const unresolvedRefs = missing.filter((r) => {
    if (withdrawnRefs.includes(r)) return false;
    const p = probeByRef.get(r);
    if (p === undefined) return true;
    return !(p.status === 200 && (p.goneSignature ?? null) === null);
  });

  const lostRefs = missing.filter(
    (r) => !withdrawnRefs.includes(r) && !unresolvedRefs.includes(r)
  );

  // 1. Refused at the door. Check first: nothing below is meaningful if we never
  //    got the page, and healing a block wastes credits and makes it worse.
  if (BLOCK_STATUSES.has(listing.status) || listing.blockSignature !== null) {
    evidence.push(
      `listing returned HTTP ${listing.status}` +
        (listing.blockSignature ? ` with block signature "${listing.blockSignature}"` : "")
    );
    evidence.push("healing cannot clear a block; backing off instead");
    return {
      cause: "blocked",
      withdrawnRefs: [],
      lostRefs: [],
      unresolvedRefs: [],
      healable: false,
      evidence,
    };
  }

  // 2. The oracle failed. Check before any repairable verdict, because a repair is
  //    only justified once we know the missing records are still published, and an
  //    unreachable permalink is not that knowledge. Refusing here costs a stale cycle;
  //    proceeding costs a fabricated record, and this project has already decided
  //    which of those is worse.
  if (unresolvedRefs.length > 0) {
    evidence.push(
      `${unresolvedRefs.length} missing record(s) could not be checked: their permalinks ` +
        `did not answer (transport failure, timeout or 5xx): ${unresolvedRefs.slice(0, 5).join(", ")}` +
        (unresolvedRefs.length > 5 ? ` and ${unresolvedRefs.length - 5} more` : "")
    );
    evidence.push(
      "a repair asserts the missing records are still published, and that could not be " +
        "established, so none was attempted"
    );
    return {
      cause: "drift",
      withdrawnRefs,
      lostRefs,
      unresolvedRefs,
      healable: false,
      evidence,
    };
  }

  // 3. Withdrawals, recorded whether or not anything else is wrong.
  if (withdrawnRefs.length > 0) {
    // Say which signal actually fired. Claiming "404 or 410" when a body phrase or a
    // redirect established the withdrawal would put a number in the incident log that
    // the probe never saw, in the one place the log exists to be checkable.
    const signals = withdrawnRefs.map((r) => {
      const p = probeByRef.get(r);
      if (p === undefined) return "unknown";
      if (WITHDRAWN_STATUSES.has(p.status)) return `HTTP ${p.status}`;
      return p.goneSignature ?? "gone";
    });
    const distinct = [...new Set(signals)];
    evidence.push(
      `${withdrawnRefs.length} notice(s) absent from the listing AND their permalinks no ` +
        `longer serve the record (${distinct.join("; ")}): ${withdrawnRefs.slice(0, 5).join(", ")}` +
        (withdrawnRefs.length > 5 ? ` and ${withdrawnRefs.length - 5} more` : "")
    );
    // Source-neutral wording. This line is rendered in the incident timeline, and the
    // same code path covers a regulator withdrawing a notice and a marketplace seller
    // delisting an item.
    evidence.push("removed at source, not lost by us: retained as last-good, never healed");
  }

  // 3. Every loss is explained by withdrawal and nothing else is structurally wrong.
  //    This is the case a naive healer gets wrong: it sees the row count fall, calls
  //    it a cliff, heals, and invents replacements for records that were deliberately
  //    removed. We report it as "gone" rather than "healthy" because a withdrawal is
  //    an event worth surfacing, and because the refusal to heal has to be visible
  //    rather than implied by an absence.
  //
  //    Structural evidence means a field that broke for some reason other than there
  //    being nothing to measure. Over zero rows every field is trivially 100% null, so
  //    an empty extraction yields a full set of field breaches that say nothing about
  //    whether the page changed or legitimately emptied. Only withdrawal evidence
  //    separates those two, so field reports are discounted entirely on an empty run.
  const structuralEvidence = report.rows === 0 ? [] : report.fields.filter((f) => f.breached);

  if (lostRefs.length === 0 && withdrawnRefs.length > 0 && structuralEvidence.length === 0) {
    evidence.push(
      report.rows === 0
        ? `every previously extracted notice was withdrawn, so the empty result is the ` +
            `source's own state rather than a failure to read it`
        : `all ${withdrawnRefs.length} missing record(s) accounted for by withdrawal; ` +
            `remaining ${report.rows} rows satisfy contract ${report.contractVersion}`
    );
    return { cause: "gone", withdrawnRefs, lostRefs: [], unresolvedRefs: [], healable: false, evidence };
  }

  if (lostRefs.length === 0 && withdrawnRefs.length === 0 && report.passed) {
    return { cause: "healthy", withdrawnRefs, lostRefs: [], unresolvedRefs: [], healable: false, evidence };
  }

  // 4. Pagination: the rows we did get land suspiciously close to a single page,
  //    and the notices we lost are all still individually published.
  const perPage = input.rowsPerPage;
  const everyLostStillLive = lostRefs.length > 0 && lostRefs.every((r) => probeByRef.get(r)?.status === 200);
  if (
    perPage !== undefined &&
    report.rows > 0 &&
    report.rows <= perPage &&
    report.baselineRows !== null &&
    report.baselineRows > perPage &&
    everyLostStillLive &&
    structuralEvidence.length === 0
  ) {
    evidence.push(
      `returned ${report.rows} rows against a baseline of ${report.baselineRows}, ` +
        `which is one page of ${perPage}`
    );
    evidence.push(
      `all ${lostRefs.length} missing notice(s) still return HTTP 200 at their permalinks, ` +
        `so they are published but unreached`
    );
    return { cause: "pagination", withdrawnRefs, lostRefs, unresolvedRefs: [], healable: true, evidence };
  }

  // 5. Drift. The data is still there in a different shape.
  for (const f of report.fields.filter((f) => f.breached)) {
    if (f.typeErrors > 0) {
      evidence.push(
        `field ${f.field} failed type parsing on ${f.typeErrors} of ${report.rows} rows ` +
          `(examples: ${f.sampleRefs.join(", ")})`
      );
    } else {
      evidence.push(
        `field ${f.field} null rate ${(f.nullRate * 100).toFixed(1)}% against a limit of ` +
          `${(f.nullRateLimit * 100).toFixed(1)}% over ${report.rows} rows ` +
          `(examples: ${f.sampleRefs.join(", ")})`
      );
    }
  }
  if (lostRefs.length > 0) {
    evidence.push(
      `${lostRefs.length} notice(s) missing from the listing while their permalinks still ` +
        `return HTTP 200: ${lostRefs.slice(0, 5).join(", ")}`
    );
  }
  if (listing.status === 200 && report.rows === 0) {
    evidence.push(`listing fetched cleanly (HTTP 200, ${listing.bodyBytes} bytes) but yielded no rows`);
  }

  return { cause: "drift", withdrawnRefs, lostRefs, unresolvedRefs: [], healable: true, evidence };
}

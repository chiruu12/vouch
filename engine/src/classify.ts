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

  const probeByRef = new Map(permalinks.map((p) => [p.ref, p.status]));
  const withdrawnRefs = missing.filter((r) => {
    const s = probeByRef.get(r);
    return s !== undefined && WITHDRAWN_STATUSES.has(s);
  });
  const lostRefs = missing.filter((r) => !withdrawnRefs.includes(r));

  // 1. Refused at the door. Check first: nothing below is meaningful if we never
  //    got the page, and healing a block wastes credits and makes it worse.
  if (BLOCK_STATUSES.has(listing.status) || listing.blockSignature !== null) {
    evidence.push(
      `listing returned HTTP ${listing.status}` +
        (listing.blockSignature ? ` with block signature "${listing.blockSignature}"` : "")
    );
    evidence.push("healing cannot clear a block; backing off instead");
    return { cause: "blocked", withdrawnRefs: [], lostRefs: [], healable: false, evidence };
  }

  // 2. Withdrawals, recorded whether or not anything else is wrong.
  if (withdrawnRefs.length > 0) {
    evidence.push(
      `${withdrawnRefs.length} notice(s) absent from the listing AND their permalinks return ` +
        `404 or 410: ${withdrawnRefs.slice(0, 5).join(", ")}` +
        (withdrawnRefs.length > 5 ? ` and ${withdrawnRefs.length - 5} more` : "")
    );
    evidence.push("withdrawn by the regulator, not lost by us: retained as last-good, never healed");
  }

  // 3. Every loss is explained by withdrawal and the contract otherwise holds.
  //    This is the case a naive healer gets wrong: it sees the row count fall, calls
  //    it a cliff, heals, and invents replacements for records that were deliberately
  //    removed. We report it as "gone" rather than "healthy" because a withdrawal is
  //    an event worth surfacing, and because the refusal to heal has to be visible
  //    rather than implied by an absence.
  const structuralBreaches = report.breaches.filter((b) => !isRowCountBreach(b));
  if (lostRefs.length === 0 && structuralBreaches.length === 0) {
    if (withdrawnRefs.length > 0) {
      evidence.push(
        `all ${withdrawnRefs.length} missing record(s) accounted for by withdrawal; ` +
          `remaining ${report.rows} rows satisfy contract ${report.contractVersion}`
      );
      return { cause: "gone", withdrawnRefs, lostRefs: [], healable: false, evidence };
    }
    return { cause: "healthy", withdrawnRefs, lostRefs: [], healable: false, evidence };
  }

  // 4. Pagination: the rows we did get land suspiciously close to a single page,
  //    and the notices we lost are all still individually published.
  const perPage = input.rowsPerPage;
  const everyLostStillLive = lostRefs.length > 0 && lostRefs.every((r) => probeByRef.get(r) === 200);
  if (
    perPage !== undefined &&
    report.rows > 0 &&
    report.rows <= perPage &&
    report.baselineRows !== null &&
    report.baselineRows > perPage &&
    everyLostStillLive &&
    structuralBreaches.length === 0
  ) {
    evidence.push(
      `returned ${report.rows} rows against a baseline of ${report.baselineRows}, ` +
        `which is one page of ${perPage}`
    );
    evidence.push(
      `all ${lostRefs.length} missing notice(s) still return HTTP 200 at their permalinks, ` +
        `so they are published but unreached`
    );
    return { cause: "pagination", withdrawnRefs, lostRefs, healable: true, evidence };
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

  return { cause: "drift", withdrawnRefs, lostRefs, healable: true, evidence };
}

/** Row-count breaches are ambiguous on their own: withdrawals cause them too.
 *  We only treat them as structural once withdrawal has been ruled out. */
function isRowCountBreach(breach: string): boolean {
  return breach.startsWith("row count fell") || breach.startsWith("returned ");
}

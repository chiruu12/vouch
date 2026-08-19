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
  /** Error rows the collector itself returned.
   *
   *  The listing probe goes out from wherever the supervisor runs. The collector goes
   *  out from Bright Data's network, and those are different places that get treated
   *  differently by the same site. A wall the collector hits and the probe does not was
   *  invisible here: zero rows, a clean 200 from our side, diagnosed as drift, and the
   *  refusal that this project is built around never fired. The scraper reporting that
   *  it was refused is first-hand evidence about the path that actually matters. */
  extractionErrors?: readonly { error: string; error_code?: string }[];
}

/** Statuses that mean "we were refused", not "the content changed". */
const BLOCK_STATUSES = new Set([401, 403, 407, 429, 451, 503]);

/** Extraction errors that mean "we were refused", not "the page changed". Kept narrow,
 *  like every other detector here: a false positive stops a repair that should have
 *  happened, which is a cost, but a false negative heals a block, which is the failure
 *  this branch exists to prevent. */
const BLOCK_WORDS =
  /(forbidden|blocked|captcha|challenge|rate.?limit|too many requests|access denied|bot detect)/i;

/** The status half, built from BLOCK_STATUSES rather than written out a second time.
 *
 *  The two used to be independent lists and they disagreed. The probe side treated 401,
 *  451 and 503 as refusals; this pattern knew only 403, 407 and 429. So the same wall was
 *  refused when our own probe hit it and sent to the healer when only the collector did,
 *  which is precisely the inconsistency this branch was added to remove. Deriving one from
 *  the other means they cannot drift apart again.
 *
 *  Guarded on digits rather than `\b`. An underscore is a word character, so `\b403` never
 *  matched inside `http_403`, the shape vendors actually emit. Flattening separators fixed
 *  that one and did nothing for `http403`. A digit guard matches the number however it is
 *  glued to its neighbours while still refusing to read 403 out of 4030. */
const BLOCK_STATUS_PATTERN = new RegExp(`(?<![0-9])(${[...BLOCK_STATUSES].join("|")})(?![0-9])`);

export function blockedAtSource(
  errors: readonly { error: string; error_code?: string }[]
): string | null {
  for (const e of errors) {
    const raw = `${e.error_code ?? ""} ${e.error}`;
    // Words are matched against a separator-flattened copy so `rate_limit` reads as two
    // words. The status pattern reads the raw string, because flattening is what put a
    // digit next to a word boundary in the first place.
    if (BLOCK_WORDS.test(raw.replace(/[_\-.]/g, " ")) || BLOCK_STATUS_PATTERN.test(raw)) {
      return (e.error_code ?? e.error).slice(0, 80);
    }
  }
  return null;
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

/** Statuses that mean a specific document is no longer published. */
const WITHDRAWN_STATUSES = new Set([404, 410]);

export function classify(input: ClassifyInput): Diagnosis {
  const { report, listing, baselineRefs, currentRefs, permalinks } = input;
  const evidence: string[] = [];

  const current = new Set(currentRefs);
  const missing = baselineRefs.filter((r) => !current.has(r));

  // Duplicate probes for one ref resolve to the safest answer, not the last one.
  //
  // `new Map(pairs)` keeps the last entry, so a ref probed [404, 200] resolved to 200,
  // became `lost`, and authorised a repair on a record that had already answered 404.
  // A withdrawal signal is the one that counts: it is the answer that refuses, and
  // between two contradictory readings of the same record the refusing one is the only
  // safe choice.
  const probeByRef = new Map<string, PermalinkProbe>();
  for (const p of permalinks) {
    const seen = probeByRef.get(p.ref);
    if (seen === undefined) {
      probeByRef.set(p.ref, p);
      continue;
    }
    const says = (x: PermalinkProbe): boolean =>
      WITHDRAWN_STATUSES.has(x.status) || (x.goneSignature ?? null) !== null;
    const live = (x: PermalinkProbe): boolean => x.status === 200 && (x.goneSignature ?? null) === null;
    // withdrawal beats anything; a clean 200 loses to anything that is not a clean 200.
    if (says(p) || (live(seen) && !live(p))) probeByRef.set(p.ref, p);
  }

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
  //
  //    Either path counts. Our probe being refused is evidence, and so is the collector
  //    reporting it was refused, and the second one is the one that decides whether the
  //    extraction could have worked at all.
  const sourceSideBlock = blockedAtSource(input.extractionErrors ?? []);
  if (BLOCK_STATUSES.has(listing.status) || listing.blockSignature !== null || sourceSideBlock !== null) {
    if (sourceSideBlock !== null && !BLOCK_STATUSES.has(listing.status) && listing.blockSignature === null) {
      // Worth saying explicitly in the log. A reader looking at a clean 200 next to a
      // refusal would otherwise reasonably think the classifier had lost its mind.
      evidence.push(
        `the listing answered HTTP ${listing.status} to us, but the collector was refused: ` +
          `"${sourceSideBlock}". The wall is on the scraper's path, not ours`
      );
    } else {
      evidence.push(
        `listing returned HTTP ${listing.status}` +
          (listing.blockSignature ? ` with block signature "${listing.blockSignature}"` : "") +
          (sourceSideBlock !== null ? `, and the collector reported "${sourceSideBlock}"` : "")
      );
    }
    evidence.push("healing cannot clear a block; backing off instead");
    // A withdrawal established this cycle survives the block, and it used to not.
    // Returning an empty list threw away a 404 the oracle had already seen, so the record
    // stayed in the baseline, kept being served from last-good as an active recall, and
    // had to be rediscovered once the wall came down. A block means we cannot trust what
    // we FAILED to read; it says nothing about a permalink that answered us plainly.
    // `lostRefs` stays empty on purpose: "missing while its own page is fine" is exactly
    // the inference a block invalidates, and it is the one that authorises a repair.
    if (withdrawnRefs.length > 0) {
      evidence.push(
        `${withdrawnRefs.length} record(s) were confirmed withdrawn before the block and ` +
          `remain recorded as withdrawn: ${withdrawnRefs.slice(0, 5).join(", ")}`
      );
    }
    return {
      cause: "blocked",
      withdrawnRefs,
      lostRefs: [],
      unresolvedRefs: [],
      healable: false,
      evidence,
    };
  }

  // 2. Withdrawals, recorded whether or not anything else is wrong.
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

  // 3. The oracle failed on something. Checked after the withdrawals above are on the
  //    record, and before any repairable verdict below.
  //
  //    The order used to be the other way round, which lost information: a cycle with
  //    one confirmed 404 and one unreachable permalink returned here immediately, so the
  //    withdrawal was never written into the evidence and the incident log showed
  //    `drift` with no mention that a record had been taken down. The state still
  //    carried it, which is worse rather than better: the feed knew and did not say.
  //
  //    The cause below is `drift` because the four causes describe why a field went
  //    null and the honest answer here is that we could not find out. It is not `gone`,
  //    which means every loss is explained by a withdrawal, and it is not repairable.
  //    A reader of the log sees both evidence lines and can tell the two apart.
  if (unresolvedRefs.length > 0) {
    const statuses = [
      ...new Set(
        unresolvedRefs.map((r) => {
          const p = probeByRef.get(r);
          if (p === undefined) return "never probed";
          if (p.status === 0) return "no response";
          return `HTTP ${p.status}`;
        })
      ),
    ];
    evidence.push(
      `${unresolvedRefs.length} missing record(s) could not be checked (${statuses.join("; ")}): ` +
        `${unresolvedRefs.slice(0, 5).join(", ")}` +
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

// One supervision cycle for one source: look, judge, repair only if repair is the
// right answer, and decide what we are willing to serve.
//
// The ordering matters and is not arbitrary:
//
//   probe the listing   before extracting, so a block is distinguishable from a change
//   check the contract  before diagnosing, so "something is wrong" precedes "what"
//   reconcile refs      whether or not the contract passed, because a single
//                       withdrawal trips no threshold yet still must be recorded
//   classify            before healing, so we can refuse
//   verify              after healing, because the vendor's "done" is not evidence
//
// A note on where the gate sits. `bdata scraper run --version dev` is unreachable
// from the CLI (the root command's global -v/--version shadows it), so a heal cannot
// be run and inspected before it reaches production. We therefore cannot gate
// production. What we can and do gate is SERVING: unverified output is never served
// as current, whatever state the collector itself is in. See docs/decisions.md.

import type { FailureCause, HealEvent, RecordState, SourceId } from "./types.js";
import { checkContract, type ContractReport, type SourceContract } from "./contract.js";
import { classify, type Diagnosis, type ListingProbe, type PermalinkProbe } from "./classify.js";
import { NotHealableError, synthesiseHealPrompt, type MarkupObservation } from "./prompt.js";

export type Row = Record<string, unknown>;

/** What we remember about a source between cycles. */
export interface SourceState {
  /** Refs from the most recent run that satisfied the contract. */
  baselineRefs: string[];
  baselineRows: number | null;
  lastVerifiedAt: string | null;
  /** The last output we were willing to vouch for. Served, clearly marked, when the
   *  current run cannot be verified. Better a labelled stale record than a silent
   *  wrong one. */
  lastGoodRows: Row[];
  healHistory: HealEvent[];
  /** Refs the source has withdrawn. Retained so they are never silently resurrected. */
  withdrawnRefs: string[];
}

export interface Incident {
  sourceId: SourceId;
  openedAt: string;
  closedAt: string | null;
  /** `resurrected` is not a failure. It is the one event in this system that is worth
   *  surfacing without anything being broken: a record we published as withdrawn is
   *  being offered for sale again. In a recall feed that is the most actionable thing
   *  that can happen, and it used to pass silently because the contract passes. */
  cause: FailureCause | "healthy" | "resurrected";
  evidence: string[];
  /** The synthesised prompt, or null when we refused to heal. */
  prompt: string | null;
  healAttempted: boolean;
  /** The repair could not start because one was already running on this collector.
   *  Distinct from healAttempted=false meaning "we refused to try": here we would
   *  have tried and were not allowed to, which is a wait rather than a verdict. */
  healDeferred: boolean;
  healDurationMs: number | null;
  /** Did the post-heal run satisfy the contract? */
  verified: boolean;
  /** Are we serving the new output? */
  serving: boolean;
  /** Time from detection to serving verified data again. Null while unresolved. */
  mttrMs: number | null;
  withdrawnRefs: string[];
  /** Refs that were recorded as withdrawn and have reappeared at the source. */
  resurrectedRefs: string[];
  /** Populated when we declined to heal, with the reason. */
  refusal: string | null;
}

export interface CycleResult {
  report: ContractReport;
  diagnosis: Diagnosis;
  /** Refs that came back after being published as withdrawn. Empty on a normal cycle. */
  resurrectedRefs: string[];
  incident: Incident | null;
  serving: { rows: Row[]; state: RecordState };
  nextState: SourceState;
}

/** Everything that touches the outside world, injected so cycles are testable. */
export interface CycleDeps {
  probeListing(url: string): Promise<ListingProbe>;
  runScraper(collectorId: string, url: string): Promise<{ rows: Row[]; errors: unknown[] }>;
  probePermalinks(entries: readonly { ref: string; url: string }[]): Promise<PermalinkProbe[]>;
  heal(collectorId: string, prompt: string, url: string): Promise<{ ok: boolean; durationMs: number; status: string }>;
  observeMarkup(body: string, contract: SourceContract): MarkupObservation;
  now(): Date;
}

export interface CycleArgs {
  sourceId: SourceId;
  collectorId: string;
  url: string;
  contract: SourceContract;
  state: SourceState;
  /** How a ref becomes a permalink, when the row does not carry one. */
  permalinkFor(ref: string): string | null;
  refOf(row: Row): string;
  rowsPerPage?: number;
  extraPaths?: readonly string[];
}

export function emptyState(): SourceState {
  return {
    baselineRefs: [],
    baselineRows: null,
    lastVerifiedAt: null,
    lastGoodRows: [],
    healHistory: [],
    withdrawnRefs: [],
  };
}

export async function runCycle(args: CycleArgs, deps: CycleDeps): Promise<CycleResult> {
  const { contract, state, url, collectorId, sourceId } = args;
  const openedAt = deps.now().toISOString();
  const openedMs = deps.now().getTime();

  // 1. The listing itself, before extraction. A block must not read as a change.
  const listing = await deps.probeListing(url);

  // 2. Extract. An empty array with no errors is the failure mode we care about most,
  //    so it arrives here as ordinary data rather than an exception.
  const run = await deps.runScraper(collectorId, url);
  const rows = run.rows;

  // 3. Contract.
  const report = checkContract(
    contract,
    rows as never,
    state.baselineRows,
    () => deps.now()
  );

  // 4. Reconcile, unconditionally. One withdrawal out of twelve breaches nothing,
  //    and would otherwise keep being served as an active recall forever.
  const currentRefs = rows.map(args.refOf).filter((r) => r.length > 0);
  const missing = state.baselineRefs.filter((r) => !currentRefs.includes(r));
  const probeTargets = missing
    .map((ref) => ({ ref, url: args.permalinkFor(ref) }))
    .filter((e): e is { ref: string; url: string } => e.url !== null);
  const permalinks = probeTargets.length > 0 ? await deps.probePermalinks(probeTargets) : [];

  // 5. Diagnose.
  const diagnosis = classify({
    report,
    listing,
    baselineRefs: state.baselineRefs,
    currentRefs,
    permalinks,
    ...(args.rowsPerPage !== undefined ? { rowsPerPage: args.rowsPerPage } : {}),
  });

  // A ref we published as withdrawn, present in the extraction again. Its permalink is
  // not probed here: the record is in the listing, which is stronger evidence of being
  // live than a 200 on its own page would be.
  const resurrectedRefs = state.withdrawnRefs.filter((r) => currentRefs.includes(r));
  const resurrected = new Set(resurrectedRefs);

  // Withdrawn is a current status, not a permanent mark, so a resurrected ref leaves the
  // list. The incident is what preserves that it was withdrawn and came back; keeping it
  // in withdrawnRefs as well would show the same record as both withdrawn and on sale.
  const knownWithdrawn = [...new Set([...state.withdrawnRefs, ...diagnosis.withdrawnRefs])].filter(
    (r) => !resurrected.has(r)
  );

  const nextStateOnGoodRun = {
    baselineRefs: currentRefs,
    baselineRows: rows.length,
    lastVerifiedAt: report.at,
    lastGoodRows: rows,
    healHistory: state.healHistory,
    withdrawnRefs: knownWithdrawn,
  };

  // --- healthy, and possibly a resurrection --------------------------------
  if (diagnosis.cause === "healthy") {
    // Nothing is wrong, so the rows are served either way. What changes is whether the
    // cycle stays silent about it.
    const resurrectionIncident: Incident | null =
      resurrectedRefs.length === 0
        ? null
        : {
            sourceId,
            openedAt,
            closedAt: report.at,
            cause: "resurrected",
            evidence: [
              `${resurrectedRefs.length} record(s) previously published as withdrawn are ` +
                `present in the listing again: ${resurrectedRefs.slice(0, 5).join(", ")}` +
                (resurrectedRefs.length > 5 ? ` and ${resurrectedRefs.length - 5} more` : ""),
              `contract ${report.contractVersion} passed over ${report.rows} rows, so this ` +
                `is the source's own change rather than a reading error on our part`,
              "no longer marked withdrawn; the withdrawal and the return are both on the record",
            ],
            prompt: null,
            healAttempted: false,
            healDeferred: false,
            healDurationMs: null,
            verified: true,
            serving: true,
            mttrMs: 0,
            withdrawnRefs: [],
            resurrectedRefs,
            refusal: null,
          };

    return {
      report,
      diagnosis,
      resurrectedRefs,
      incident: resurrectionIncident,
      serving: { rows, state: "verified" },
      nextState: nextStateOnGoodRun,
    };
  }

  const incident: Incident = {
    sourceId,
    openedAt,
    closedAt: null,
    cause: diagnosis.cause,
    evidence: diagnosis.evidence,
    prompt: null,
    healAttempted: false,
    healDeferred: false,
    healDurationMs: null,
    verified: false,
    serving: false,
    mttrMs: null,
    withdrawnRefs: diagnosis.withdrawnRefs,
    resurrectedRefs,
    refusal: null,
  };

  // --- gone ----------------------------------------------------------------
  // Records were withdrawn and nothing else is wrong. The rows we still have satisfy
  // the contract, so they are served normally; the withdrawn ones are marked, never
  // regenerated. Healing here is the failure this project exists to prevent.
  if (diagnosis.cause === "gone") {
    incident.closedAt = report.at;
    incident.refusal =
      "records were withdrawn at source and their permalinks no longer resolve; " +
      "healing would fabricate replacements for records that were deliberately removed";

    // The survivors are vouched for even though `report.passed` is false, and that is
    // deliberate rather than an oversight. On a withdrawal the contract fails on volume:
    // the row count dropped because records were taken down. The classifier has already
    // established there is no field-level breach, so every remaining row was read
    // cleanly. Refusing to vouch for a correctly extracted row because a different row
    // no longer exists would be the wrong lesson from the right rule.
    //
    // What this does mean is that a naive re-run of the same contract elsewhere will
    // disagree with this verdict. `sourceCard` in snapshot.ts used to do exactly that,
    // and the feed labelled every record verified while its own health strip called the
    // source unverified. The fix belongs there, not here.
    incident.verified = true;
    incident.serving = true;
    incident.mttrMs = 0;
    return {
      report,
      diagnosis,
      resurrectedRefs,
      incident,
      serving: { rows, state: "verified" },
      nextState: {
        baselineRefs: currentRefs,
        baselineRows: rows.length,
        lastVerifiedAt: report.at,
        lastGoodRows: rows,
        healHistory: state.healHistory,
        withdrawnRefs: knownWithdrawn,
      },
    };
  }

  // --- blocked -------------------------------------------------------------
  // Serve the last thing we could vouch for, labelled stale. Do not heal: rewriting
  // selectors cannot clear a block, and attempting it burns credits and can deepen
  // the block.
  if (!diagnosis.healable) {
    incident.refusal =
      diagnosis.cause === "blocked"
        ? "the source refused the request; healing cannot clear a block"
        : "classifier marked this diagnosis unhealable";
    return {
      report,
      diagnosis,
      resurrectedRefs,
      incident,
      serving: { rows: state.lastGoodRows, state: "unverified" },
      nextState: { ...state, withdrawnRefs: knownWithdrawn },
    };
  }

  // --- drift and pagination: repair, then check the repair ------------------
  const markup = deps.observeMarkup(listing.body ?? "", contract);
  let prompt: string;
  try {
    prompt = synthesiseHealPrompt({
      diagnosis,
      report,
      markup,
      targetUrl: url,
      ...(args.extraPaths !== undefined ? { extraPaths: args.extraPaths } : {}),
    });
  } catch (e) {
    // The synthesiser is the second gate and it is allowed to veto the classifier.
    incident.refusal = e instanceof NotHealableError ? e.message : String(e);
    return {
      report,
      diagnosis,
      resurrectedRefs,
      incident,
      serving: { rows: state.lastGoodRows, state: "unverified" },
      nextState: { ...state, withdrawnRefs: knownWithdrawn },
    };
  }

  incident.prompt = prompt;
  const healed = await deps.heal(collectorId, prompt, url);
  incident.healDurationMs = healed.durationMs;

  // Heal is exclusive per collector: a second call while one is running is rejected
  // outright and nothing is attempted. That is a deferral, not a failed repair, and
  // conflating them would put "we tried to fix this and could not" in the incident log
  // for an event where we never got to try. Serve last-good and come back.
  if (healed.status === "heal_busy") {
    incident.healDeferred = true;
    incident.refusal =
      "a repair is already running on this collector, so this one could not start; " +
      "nothing was attempted and the collector is unchanged";
    return {
      report,
      diagnosis,
      resurrectedRefs,
      incident,
      serving: { rows: state.lastGoodRows, state: "unverified" },
      nextState: { ...state, withdrawnRefs: knownWithdrawn },
    };
  }

  // A call that never reached the collector is not a repair either. `heal_busy` was the
  // first version of this distinction and it was drawn too narrowly: any other transport
  // or CLI failure still fell through and was recorded as a repair that ran and produced
  // nothing, which is the same misreading one door along. The collector is untouched in
  // both cases, and the incident log exists to keep exactly this column honest.
  if (healed.status === "heal_call_failed" || healed.status === "heal_trigger_failed") {
    incident.healDeferred = true;
    incident.refusal =
      `the repair could not be sent to the collector (${healed.status}); ` +
      "nothing was attempted and the collector is unchanged";
    return {
      report,
      diagnosis,
      resurrectedRefs,
      incident,
      serving: { rows: state.lastGoodRows, state: "unverified" },
      nextState: { ...state, withdrawnRefs: knownWithdrawn },
    };
  }

  incident.healAttempted = true;

  // Verify. The heal reporting "done" is not evidence; a measured run of it is.
  const after = await deps.runScraper(collectorId, url);
  const afterReport = checkContract(contract, after.rows as never, state.baselineRows, () => deps.now());
  const afterRefs = after.rows.map(args.refOf).filter((r) => r.length > 0);

  const healEvent: HealEvent = {
    at: deps.now().toISOString(),
    cause: diagnosis.cause,
    prompt,
    verified: afterReport.passed,
    promoted: afterReport.passed,
    collectorId,
    durationMs: healed.durationMs,
  };

  if (afterReport.passed) {
    incident.closedAt = afterReport.at;
    incident.verified = true;
    incident.serving = true;
    incident.mttrMs = deps.now().getTime() - openedMs;
    return {
      report: afterReport,
      diagnosis,
      resurrectedRefs,
      incident,
      serving: { rows: after.rows, state: "healed" },
      nextState: {
        baselineRefs: afterRefs,
        baselineRows: after.rows.length,
        lastVerifiedAt: afterReport.at,
        lastGoodRows: after.rows,
        healHistory: [...state.healHistory, healEvent],
        withdrawnRefs: knownWithdrawn,
      },
    };
  }

  // The heal did not restore the contract. This is the case that actually happened
  // to us: status "done", a completed request_fulfillment_validator stage, and zero
  // rows. The incident stays open and we keep serving last-good, labelled.
  incident.refusal =
    `heal reported "${healed.status}" but the result still fails the contract: ` +
    afterReport.breaches.slice(0, 2).join("; ");
  return {
    report: afterReport,
    diagnosis,
    resurrectedRefs,
    incident,
    serving: { rows: state.lastGoodRows, state: "unverified" },
    nextState: {
      ...state,
      healHistory: [...state.healHistory, healEvent],
      withdrawnRefs: knownWithdrawn,
    },
  };
}

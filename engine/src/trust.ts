// What the feed is willing to claim.
//
// Two decisions, kept together and kept out of the assembly around them. Everything else
// in snapshot.ts is arrangement: read this file, join that one, sort, write. These two are
// the only places where the engine decides what it is prepared to assert to a reader, and
// both were wrong this week in ways that were easy to miss inside a 745-line file. A
// record was labelled verified while the health strip directly above it reported the
// source as failed, and a scraped permalink was published under a trust pill with nobody
// checking it pointed at the site we actually read.
//
// `deriveTrust` takes a contract rather than a source id on purpose. Looking the source up
// in the published-metadata table meant a lookup that could miss, a throw no caller could
// trigger, and a dependency on that whole table from a function whose job is arithmetic
// over one contract and one piece of state. Passing what is needed removes the failure
// mode rather than handling it.

import { checkContract, type SourceContract } from "./contract.js";
import type { SourceState } from "./runner.js";
import type { RecordState } from "./types.js";

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
export function deriveTrust(
  contract: SourceContract,
  rows: readonly unknown[],
  state: SourceState | null
): RecordState {
  const report = checkContract(contract, rows as Record<string, unknown>[], state?.baselineRows ?? null);
  const volumeOnly = report.breaches.length > 0 && report.fields.every((f) => !f.breached);
  // The withdrawals have to actually account for the missing rows, not merely exist.
  //
  // This used to be `withdrawnRefs.length > 0`, which vouched for any volume breach that
  // happened to coincide with a withdrawal. Five records silently stopping extracting
  // while one unrelated record was taken down published all seven survivors as verified,
  // because one withdrawal was treated as explaining a drop of five. Cleanly read is not
  // the same as complete, and a feed that quietly loses recalls is the failure this
  // project is about, arriving as a shortfall rather than as a phantom.
  //
  // The comparison is on counts because trust is derived from rows a source knows nothing
  // about the refs of. `withdrawnRefs` accumulates across cycles while `baselineRows`
  // tracks the last passing run, so a long-lived source with many past withdrawals gets a
  // larger allowance than a strict per-cycle reconciliation would give it. That is a known
  // slack, not an oversight: it is bounded by the number of records the source has ever
  // withdrawn, and it is strictly tighter than the "any withdrawal at all" it replaced.
  const shortfall = (state?.baselineRows ?? report.rows) - report.rows;
  const explainedByWithdrawal =
    volumeOnly && shortfall > 0 && shortfall <= (state?.withdrawnRefs.length ?? 0);
  if (!(report.passed || explainedByWithdrawal)) return "unverified";
  return (state?.healHistory.some((h) => h.verified) ?? false) ? "healed" : "verified";
}

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

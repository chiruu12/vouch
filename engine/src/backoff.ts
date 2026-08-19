// What the loop remembers about failing, and what that memory is allowed to change.
//
// Until this module existed, every cycle started from nothing. A source behind a bot
// wall was hammered on the same schedule forever, and a drift the healer could not fix
// was sent back to the healer every cycle with the same prompt, at the same cost, to
// fail the same way. The loop could detect, refuse and repair, but it could not learn
// that it was getting nowhere.
//
// Two different memories, because a wall and a broken repair want opposite responses:
//
//   blocked          the source is telling us to stop. Backing off is the fix, and the
//                    only fix. Cooldown grows exponentially and the whole cycle is
//                    skipped while it holds, including the scrape.
//
//   drift/pagination the source changed and our repair is not landing. Backing off does
//                    nothing here, because nothing is rate limiting us. What is wanted
//                    is to stop paying for a repair that has failed REPAIR_BUDGET times
//                    and say plainly that a person is needed. Reading continues.
//
// Nothing in here delays or suppresses a withdrawal. `gone` is not a failure, it never
// opens a streak, and a cooling source serves exactly what the blocked branch would
// serve anyway: last-good with confirmed withdrawals already removed, labelled
// unverified. A cooldown changes what we spend, never what we claim.

import type { FailureCause } from "./types.js";

export interface Streak {
  /** What has been going wrong. A different cause restarts the count rather than
   *  adding to it: three drifts then a block is not a four-cycle block. */
  cause: FailureCause;
  count: number;
  /** When the current run of this cause started, for the incident log. */
  since: string;
}

/** First cooldown after a single block. Short on purpose. Most walls are a rate limit
 *  that clears on its own, and the cost of waiting a minute is one stale cycle. */
export const BASE_COOLDOWN_MS = 60_000;

/** Ceiling. Past an hour we are no longer backing off, we are offline, and the
 *  incident log should be what escalates rather than an ever longer sleep. */
export const MAX_COOLDOWN_MS = 60 * 60_000;

/** Consecutive failed repairs on one cause before we stop asking the healer.
 *
 *  Three because two is inside the noise. A repair can fail once because the collector
 *  was mid-deploy and once more because the page was being edited while we read it.
 *  Three consecutive failures on the same cause is the source having changed in a way
 *  this prompt cannot describe, and the fourth attempt has no new information in it. */
export const REPAIR_BUDGET = 3;

/** Causes where a repair is the intended response, so a repair budget applies. */
const REPAIRABLE: ReadonlySet<FailureCause> = new Set<FailureCause>(["drift", "pagination"]);

/** How long to wait after `count` consecutive blocks.
 *
 *  Doubling, capped. Deliberately not jittered: one supervisor per source means there
 *  is no thundering herd to spread out, and a deterministic delay is one a test can
 *  assert and an operator can predict. */
export function cooldownMs(count: number): number {
  if (count < 1) return 0;
  const grown = BASE_COOLDOWN_MS * 2 ** (count - 1);
  return Math.min(grown, MAX_COOLDOWN_MS);
}

/** Fold this cycle's verdict into the streak.
 *
 *  `gone` and `healthy` are cycles we vouched for, so they clear it. Passing them here
 *  is allowed and returns null rather than throwing, because the caller should not have
 *  to branch before recording an outcome. */
export function advance(
  prev: Streak | null,
  cause: FailureCause | "healthy" | "resurrected",
  at: string
): Streak | null {
  if (cause === "healthy" || cause === "resurrected" || cause === "gone") return null;
  if (prev !== null && prev.cause === cause) {
    return { cause, count: prev.count + 1, since: prev.since };
  }
  return { cause, count: 1, since: at };
}

/** Has this cause already burned its repair budget?
 *
 *  Takes the streak as it stood BEFORE this cycle, deliberately. Asking whether the
 *  streak including this cycle has reached the budget spends one attempt fewer than the
 *  budget names: at the third failure the count is already three, and the third repair
 *  never runs. The question here is "have REPAIR_BUDGET repairs already been tried and
 *  failed", so it is asked of the failures that have actually happened.
 *
 *  The cause must match. A source that drifted three times and has now changed its
 *  pagination gets a fresh budget, because the evidence going into the prompt is
 *  different and there is a real reason to expect a different result. Only the repairable
 *  causes have a budget at all: a block is never sent to the healer, and `gone` is not a
 *  failure. */
export function repairExhausted(prior: Streak | null, cause: FailureCause): boolean {
  if (prior === null) return false;
  if (!REPAIRABLE.has(cause)) return false;
  if (prior.cause !== cause) return false;
  return prior.count >= REPAIR_BUDGET;
}

/** Milliseconds still to wait, or null when the source is free to be read.
 *
 *  A missing or unparseable deadline reads as "not cooling". The failure mode of a
 *  corrupt state file should be one wasted request, not a source that is never read
 *  again with no way to tell why. */
export function coolingDown(cooldownUntil: string | null | undefined, now: Date): number | null {
  if (cooldownUntil === null || cooldownUntil === undefined) return null;
  const until = Date.parse(cooldownUntil);
  if (Number.isNaN(until)) return null;
  const remaining = until - now.getTime();
  return remaining > 0 ? remaining : null;
}

/** The deadline to store after a block, given the streak that block produced. */
export function cooldownUntil(streak: Streak | null, now: Date): string | null {
  if (streak === null || streak.cause !== "blocked") return null;
  return new Date(now.getTime() + cooldownMs(streak.count)).toISOString();
}

export function describeWait(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

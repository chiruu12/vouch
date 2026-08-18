// The one decision that matters: may this change be made without a person seeing it?
//
// This used to be `c.reversible` tested inline in the CLI, with `applyAlias` throwing as
// a backstop and the actual reasoning living in a comment. That is three places and no
// single thing to test, for the decision that governs whether a machine may edit how
// this system reads the world.
//
// The rule, stated once:
//
//   A change may be applied unattended only when it is reversible by deleting one line
//   AND it cannot alter a reading the engine already makes.
//
// Both halves are required and the second is the one that is easy to lose. Reversibility
// bounds what a wrong change costs; it does not make the change right. An alias that
// competes with a name already resolving would be just as reversible and would silently
// change published data, so it is refused. Only filling a field that resolves to null on
// every row qualifies, because there is no existing reading to disturb.
//
// Everything else is a proposal with its evidence attached, and a person applies it.

import type { Change } from "./change.js";

export interface Verdict {
  /** May this be applied with nobody watching? */
  unattended: boolean;
  /** The reason, recorded in the log next to the change. */
  because: string;
}

export function mayApplyUnattended(c: Change): Verdict {
  switch (c.kind) {
    case "alias":
      // Callers only construct an alias change for a canonical field that resolved to
      // null on every row of the capture, and `applyAlias` appends rather than prepends,
      // so an existing name keeps precedence. Both conditions hold by construction; the
      // evolver's tests are what keep them holding.
      return {
        unattended: true,
        because: "fills a field that was null on every row, and is undone by deleting one name",
      };

    case "gone-marker":
      // The asymmetry is the whole point. A missed marker leaves a withdrawn record on
      // the feed until a person notices, which is bad. A wrong marker takes a live
      // safety recall off the feed and reports it as withdrawn, which is the failure
      // this project exists to prevent, and it does it silently and to every record the
      // phrase happens to match. Evidence can make a phrase look certain; it cannot make
      // this direction of error cheap.
      return {
        unattended: false,
        because: "a wrong withdrawal phrase removes live recalls from the feed, so a person reads the evidence",
      };

    case "heal-strategy":
      // A repair instruction is the one input that can damage the collector itself. A
      // bad prompt has permanently wedged a collector in this account, and two more were
      // wedged by repairs that failed to trigger and kept their lock. A wedged collector
      // cannot be un-wedged from the CLI, so this is not reversible in any useful sense.
      return {
        unattended: false,
        because: "a repair prompt can permanently wedge a collector, which no later edit undoes",
      };
  }
}

/** Split a batch the way the evolver reports it. */
export function partition(changes: readonly Change[]): { auto: Change[]; proposed: Change[] } {
  const auto: Change[] = [];
  const proposed: Change[] = [];
  for (const c of changes) {
    if (mayApplyUnattended(c).unattended) auto.push(c);
    else proposed.push(c);
  }
  return { auto, proposed };
}

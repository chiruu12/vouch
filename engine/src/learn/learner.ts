// The seam the evolver is built around.
//
// Before this there were three functions and a `main` that called each by name, so
// every new thing the system could learn meant editing the orchestrator, and the
// orchestrator was also the thing that decided what could be applied unattended and the
// thing that wrote the files. Adding the two learners this interface exists for would
// have meant three more edits to the same function, each one a chance to get the
// apply-without-asking decision wrong for a kind of change it was never written for.
//
// Now a learner is handed evidence and returns proposals, and that is all it does. It
// does not read files, decide what is safe, or write anything. The policy lives in
// policy.ts and applies to every kind uniformly, including kinds added later, which is
// the property worth having: a new learner cannot quietly grant itself permission.

import type { Change } from "./change.js";
import type { PhraseLedger } from "./gone-markers.js";

/** One collector output, already flattened to rows. */
export interface Capture {
  label: string;
  source: string;
  rows: Record<string, unknown>[];
}

/** Everything gathered once and handed to every learner, so that gathering happens in
 *  one place and a learner cannot reach past what it was given. */
export interface Evidence {
  captures: readonly Capture[];
  /** Phrase counts accumulated by the oracle. Never contains page text. */
  ledger: PhraseLedger;
  /** What the oracle already looks for on a given source. Scoped: see proposeMarkers. */
  knownMarkersFor: (source: string) => readonly string[];
  /** Refs the source is known to have published, used to check an identifier candidate
   *  against something rather than adopting it on shape alone. */
  knownRefsFor(source: string): string[];
}

export interface Learner {
  /** Stable id, used in output so a reader can tell which learner said what. */
  readonly id: string;
  /** One line, present tense, describing what this learner watches for. */
  readonly learns: string;
  propose(evidence: Evidence): Change[];
}

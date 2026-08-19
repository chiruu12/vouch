// Every learner the evolver runs, in one list.
//
// This is the whole of the extension point. Adding something the system can learn is an
// entry here and a module implementing `Learner`; the orchestrator, the apply policy and
// the reporting do not change, and cannot be talked into treating a new kind as safe,
// because the policy is written per kind and defaults to asking a person.

import type { Learner } from "./learner.js";
import { inferAliases } from "../evolve.js";
import { proposeMarkers } from "./gone-markers.js";

const aliasLearner: Learner = {
  id: "aliases",
  learns: "field names a collector used that the adapters did not know",
  propose: (e) =>
    e.captures.flatMap((cap) =>
      inferAliases({ label: cap.label, source: cap.source, rows: cap.rows }, e.knownRefsFor(cap.source))
    ),
};

const goneMarkerLearner: Learner = {
  id: "gone-markers",
  learns: "phrases that appear only on pages proved withdrawn",
  propose: (e) =>
    proposeMarkers(e.ledger, e.knownMarkersFor).map((c) => ({
      kind: "gone-marker" as const,
      source: c.source,
      marker: c.marker,
      goneRefs: c.goneRefs,
      liveRefs: c.liveRefs,
      what: `${c.source}: treat "${c.marker}" as a withdrawal phrase`,
      evidence:
        `seen on ${c.goneRefs} distinct records whose permalink proved gone, and on ` +
        `${c.liveRefs} records proved live. Read it before accepting: a phrase that is ` +
        `one listing's own wording rather than the site's would take live recalls off the feed`,
    })),
};

export const LEARNERS: readonly Learner[] = [aliasLearner, goneMarkerLearner];

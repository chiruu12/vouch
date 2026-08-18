// The withdrawal phrases the oracle looks for, and how one gets added or taken away.
//
// This is the evolution path the gone-marker learner was missing. It could propose a
// phrase and there was nowhere for an accepted phrase to go, because the list was a
// hardcoded array. `--accept` printed "make the change and commit it", which is a
// suggestion, not a path.
//
// The asymmetry that makes the whole thing safe is worth stating plainly, because it is
// the reason this can be automated at all:
//
//   ADDING a phrase is dangerous. A wrong one marks live safety recalls withdrawn and
//   takes them off the feed, silently, for every record it happens to match. So adding
//   always requires a person, however strong the evidence looks.
//
//   REMOVING a phrase is safe. The worst case is that a genuinely withdrawn record
//   stays on the feed until somebody notices, which is the failure this system already
//   handles by refusing to heal. So removal can run unattended.
//
// So the supervisor evolves in one direction on its own. A learned phrase that is ever
// seen on a page we proved was live is retracted immediately, without asking, and the
// retraction is recorded with the record that disproved it. A phrase earns its place by
// surviving contact with live pages, and loses it the moment it does not.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { PhraseLedger } from "./gone-markers.js";

/** The phrases we shipped with. Not learned, not retractable: these are the ones a
 *  person wrote against pages they had read, and they are the floor the oracle keeps
 *  even if every learned phrase is retracted. */
export const BUILTIN_MARKERS: readonly string[] = [
  "no longer available",
  "this listing has ended",
  "listing ended",
  "item is no longer available",
  "no longer for sale",
  "has been removed",
  "page not found",
  "notice not found",
  "recall not found",
  "404 not found",
];

export interface LearnedMarker {
  marker: string;
  source: string;
  acceptedAt: string;
  /** Distinct withdrawn records that carried it when it was accepted. */
  goneRefs: number;
  evidence: string;
}

export interface RetractedMarker {
  marker: string;
  source: string;
  retractedAt: string;
  /** The record that disproved it: proved live, page carried the phrase. */
  disprovedBy: string;
}

export interface MarkerStore {
  version: number;
  learned: LearnedMarker[];
  retracted: RetractedMarker[];
}

const PATH = new URL("../../learned/markers.json", import.meta.url).pathname;

export const emptyMarkerStore = (): MarkerStore => ({ version: 1, learned: [], retracted: [] });

export function loadMarkers(): MarkerStore {
  if (!existsSync(PATH)) return emptyMarkerStore();
  try {
    return JSON.parse(readFileSync(PATH, "utf8")) as MarkerStore;
  } catch {
    // An unreadable store must not silently widen the oracle, and it must not narrow it
    // below the phrases a person wrote either. Empty means builtins only.
    return emptyMarkerStore();
  }
}

export function saveMarkers(store: MarkerStore): void {
  writeFileSync(PATH, JSON.stringify(store, null, 2) + "\n");
}

/** Loaded once per process. The oracle asks this on every probe, and re-reading a
 *  committed file per URL would make what counts as a withdrawal depend on filesystem
 *  timing. A retraction written during a cycle therefore takes effect on the next run,
 *  which is the right direction to be slow in: the phrase stays active for one more
 *  cycle at worst, and an active phrase only ever holds a record back from the feed. */
let cached: readonly string[] | null = null;

export function activeMarkersCached(): readonly string[] {
  cached ??= activeMarkers();
  return cached;
}

/** Everything the oracle currently looks for. Retracted phrases are excluded even if
 *  they somehow remain in `learned`, so a retraction cannot be undone by an edit that
 *  forgets to remove the other half. */
export function activeMarkers(store: MarkerStore = loadMarkers()): readonly string[] {
  const dead = new Set(store.retracted.map((r) => r.marker));
  const learned = store.learned.map((l) => l.marker).filter((m) => !dead.has(m));
  return [...BUILTIN_MARKERS, ...learned];
}

/** Add a phrase a person accepted. Pure: returns the next store. */
export function acceptMarker(
  store: MarkerStore,
  m: { marker: string; source: string; goneRefs: number; evidence: string },
  now: string
): MarkerStore {
  if (BUILTIN_MARKERS.includes(m.marker)) return store;
  if (store.learned.some((l) => l.marker === m.marker)) return store;
  return {
    ...store,
    learned: [
      ...store.learned,
      { marker: m.marker, source: m.source, acceptedAt: now, goneRefs: m.goneRefs, evidence: m.evidence },
    ],
    // Accepting a phrase that was previously retracted clears the retraction, so the
    // decision a person just made is the one that stands.
    retracted: store.retracted.filter((r) => r.marker !== m.marker),
  };
}

export interface Retraction {
  marker: string;
  disprovedBy: string;
}

/** Learned phrases the evidence no longer supports.
 *
 *  A phrase is disproved by a single live sighting. Not a rate, not a threshold: the
 *  claim a marker makes is "a page saying this is gone", and one live page saying it is
 *  a counterexample. Built-in phrases are not checked, because they are the floor and a
 *  person owns them. */
export function disprovedMarkers(store: MarkerStore, ledger: PhraseLedger): Retraction[] {
  const out: Retraction[] = [];
  const alreadyGone = new Set(store.retracted.map((r) => r.marker));
  for (const l of store.learned) {
    if (alreadyGone.has(l.marker)) continue;
    const rec = ledger.sources[l.source]?.[l.marker];
    const live = rec?.liveRefs ?? [];
    if (live.length > 0) out.push({ marker: l.marker, disprovedBy: live[0] ?? "unknown" });
  }
  return out;
}

export function retract(store: MarkerStore, r: Retraction, source: string, now: string): MarkerStore {
  if (store.retracted.some((x) => x.marker === r.marker)) return store;
  return {
    ...store,
    learned: store.learned.filter((l) => l.marker !== r.marker),
    retracted: [
      ...store.retracted,
      { marker: r.marker, source, retractedAt: now, disprovedBy: r.disprovedBy },
    ],
  };
}

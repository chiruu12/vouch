// Field names, as data.
//
// The adapters used to carry their alias lists inline, and every time a new collector
// turned up with a new name for an old field somebody edited a source file. That
// happened three times in two days over a single fixture, from three collectors built
// out of near-identical sentences. It is the part of this system that changes without
// anyone deciding it should, which makes it the part worth taking out of the code.
//
// `learned/aliases.json` is the store. `evolve.ts` writes it, this module reads it, and
// the adapters ask it rather than knowing anything themselves. It is committed, so a
// clone behaves identically and every change is a diff somebody can read.

import { readFileSync } from "node:fs";

export interface AliasLogEntry {
  at: string;
  source: string;
  canonical: string;
  raw: string;
  collectorId: string | null;
  evidence: string;
  applied: boolean;
  reversible: boolean;
  by: string;
}

export interface AliasStore {
  version: number;
  sources: Record<string, Record<string, string[]>>;
  log: AliasLogEntry[];
}

const STORE_URL = new URL("../learned/aliases.json", import.meta.url);

function read(): AliasStore {
  const raw = JSON.parse(readFileSync(STORE_URL, "utf8")) as AliasStore;
  if (typeof raw.version !== "number" || raw.sources === undefined) {
    throw new Error("learned/aliases.json is not an alias store");
  }
  return raw;
}

/** Read once. The store is a committed file, not a live database, and an adapter that
 *  re-read it per row would make normalisation depend on filesystem timing. */
const STORE: AliasStore = read();

export function aliasStore(): AliasStore {
  return STORE;
}

/** The names this source has ever used for a canonical field, in resolution order.
 *  Takes an explicit store so the evolver can reason about a store other than the one
 *  currently on disk, which is how "would this have found what a person had to patch
 *  by hand?" becomes a test rather than a claim. */
/** Sources whose adapter actually resolves field names through this store.
 *
 *  Named here rather than inferred, because the failure it prevents is a silent one.
 *  `applyAlias` will create a block for any source string it is handed, and the alias
 *  learner is the one change the policy clears to apply without a person watching. A
 *  learned name written where nothing reads it is an unattended change that reports
 *  success and does nothing, which is worse than a refusal: it looks like the system
 *  adapted.
 *
 *  Why the others are absent. `arcadia`'s adapter holds its own name lists because its
 *  own `pick` trims strings and coerces finite numbers, which this one does not, and the
 *  block that used to sit in the store for it was a narrower and disagreeing subset of
 *  what the adapter really reads. `ebay` has no adapter at all; its samples are evidence
 *  about a real marketplace, not an extraction path. Both were being written to.
 */
export const ALIAS_DRIVEN_SOURCES: ReadonlySet<string> = new Set(["tradewell"]);

export function readsAliasStore(source: string): boolean {
  return ALIAS_DRIVEN_SOURCES.has(source);
}

export function aliasesFor(source: string, canonical: string, store: AliasStore = STORE): readonly string[] {
  return store.sources[source]?.[canonical] ?? [canonical];
}

/** Every raw field name this source knows about, across all canonical fields. Used by
 *  the evolver to decide whether a name it is looking at is new. */
export function knownRawFields(source: string, store: AliasStore = STORE): ReadonlySet<string> {
  const out = new Set<string>();
  for (const names of Object.values(store.sources[source] ?? {})) {
    for (const n of names) out.add(n);
  }
  return out;
}

export function canonicalFields(source: string, store: AliasStore = STORE): readonly string[] {
  return Object.keys(store.sources[source] ?? {});
}

/** First non-blank value among a canonical field's aliases.
 *
 *  `pick` is deliberately the only way an adapter reaches a raw field, so a field the
 *  store does not know about cannot be read by accident, and adding a name is a data
 *  change rather than a code change. */
export function pick(
  source: string,
  canonical: string,
  row: Record<string, unknown>,
  store: AliasStore = STORE
): unknown {
  for (const name of aliasesFor(source, canonical, store)) {
    const v = row[name];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return null;
}

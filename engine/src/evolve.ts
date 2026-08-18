// Self-evolution: the part of the system that changes the supervisor rather than the
// scraper.
//
//   npm run evolve            look at the evidence, apply what is safe, propose the rest
//   npm run evolve -- --dry   show what it would do and change nothing
//   npm run evolve -- --accept 3   promote proposal 3 into the store
//
// Scraper Studio heals the collector. This heals the thing that decides whether to call
// the healer at all: the field names the adapters read, the phrases the withdrawal
// oracle recognises, the prompts the repair is asked with. Those drifted three times in
// two days on a single fixture and every time a human patched a source file.
//
// The rule that makes this safe to run unattended is not "the change looked fine". It
// is REVERSIBILITY, tested per change rather than assumed:
//
//   Auto-applied  A change that can only turn a null into a value, and can be undone by
//                 deleting one line. Adding a field alias for a canonical field that is
//                 currently null in every row is the whole category. It cannot alter a
//                 value the engine already reads, so the worst case is that a field
//                 stays null, which is where it started.
//
//   Proposed      Anything that could weaken a gate or change an existing reading.
//                 A new gone-marker can mark a live recall withdrawn. A reordered alias
//                 can change what a field already resolves to. A new repair prompt can
//                 damage a collector, which has happened twice here. These are written
//                 out with their evidence and wait for a person.
//
// A system that quietly retunes its own thresholds until nothing fails would be the
// exact opposite of what this project argues. So nothing here may loosen a contract,
// and the evolver has no access to contract.ts at all.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { aliasStore, knownRawFields, canonicalFields, pick, type AliasStore } from "./aliases.js";
import { GONE_MARKERS } from "./bdata.js";
import type { AliasChange, Change as AnyChange } from "./learn/change.js";
import { changeKey } from "./learn/change.js";
import { partition, mayApplyUnattended } from "./learn/policy.js";
import { LEARNERS } from "./learn/registry.js";
import type { Capture as LearnerCapture, Evidence } from "./learn/learner.js";
import { emptyLedger, type PhraseLedger } from "./learn/gone-markers.js";
import type { HealRecord } from "./learn/heal-strategy.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const STORE_PATH = new URL("../learned/aliases.json", import.meta.url).pathname;
const PROPOSALS_PATH = new URL("../learned/proposals.json", import.meta.url).pathname;

// --- what a change looks like ------------------------------------------------
//
// The shape moved to learn/change.ts, where each kind carries what it needs and the
// compiler enforces it. Whether a change may be applied without a person watching is
// not a property a learner declares about itself any more; it is one rule in
// learn/policy.ts, applied to every kind including kinds added later.

export type { Change, Kind } from "./learn/change.js";

// --- shape tests -------------------------------------------------------------

const isUrl = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
};

const isDateish = (v: unknown): boolean =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim());

const isRefish = (v: unknown): boolean =>
  typeof v === "string" && /^[A-Z]{2,5}-[A-Za-z0-9-]{2,}$/.test(v.trim());

/** A price, and not merely something with digits in it.
 *
 *  The first version stripped every non-digit and asked whether the remainder parsed,
 *  which made the identifier "TW-33887" a plausible price. A test caught it, which is
 *  the only reason it is not in the store. The string must READ as a number from the
 *  start, with at most a currency symbol in front. */
const isNumberish = (v: unknown): boolean => {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "object" && v !== null) {
    return Number.isFinite((v as { value?: unknown }).value as number);
  }
  if (typeof v !== "string") return false;
  return /^\s*[$£€¥]?\s*-?\d[\d,]*(\.\d+)?\s*$/.test(v);
};

const isText = (v: unknown): boolean => typeof v === "string" && v.trim().length > 1;

/** Canonical fields whose shape is distinctive enough to infer from.
 *
 *  The first version of this file inferred any field with a shape test, and `isText`
 *  matches any non-empty string, so the first dry run cheerfully offered to read
 *  `shipping` as `currency` and `sellerKey` as `seller`. Both were "reversible" in the
 *  sense the design cares about, and both were nonsense.
 *
 *  That is the lesson and it is worth stating rather than quietly patching: reversibility
 *  bounds the damage a wrong change can do, it does not make the change right. Auto-apply
 *  needs both. So inference is limited to fields where a wrong match is implausible
 *  rather than merely undoable: an identifier that matches the baseline, a URL that
 *  parses, a date that parses, a number. Everything a human would have to squint at is
 *  a proposal. */
const INFERABLE = new Set(["id", "ref", "permalink", "listedOn", "published", "price"]);

/** Canonical fields no inference may ever target, whatever the evidence.
 *
 *  `seller` is the whole list. Adapters hash the seller name at the source boundary and
 *  the published type has no field for it; a learned alias that fed something new into
 *  `seller` would be the evolver quietly building a second door into the one guarantee
 *  this project makes about people rather than data. */
export const NEVER_LEARN_INTO = new Set(["seller"]);

/** What each canonical field must look like for a raw field to be a candidate for it.
 *  Deliberately strict: a wrong alias is silent, and silence is the failure mode this
 *  whole project is about. */
const SHAPE: Record<string, (v: unknown) => boolean> = {
  id: isRefish,
  ref: isRefish,
  permalink: isUrl,
  listedOn: isDateish,
  published: isDateish,
  price: isNumberish,
  title: isText,
  brand: isText,
  condition: isText,
  location: isText,
  currency: isText,
  hazard: isText,
  risk: isText,
  category: isText,
  action: isText,
  affectedUnits: isText,
  seller: isText,
};

// --- alias inference ---------------------------------------------------------

interface Capture {
  label: string;
  source: string;
  rows: Record<string, unknown>[];
}

/** Raw field names that must never be mapped to anything, whatever their shape.
 *  `input` is the collector echoing back the URL it was given; mapping it to permalink
 *  would give every row the same link. The seller names are here because the adapters
 *  hash them at the boundary and a learned alias must not open a second door. */
const NEVER_MAP = new Set([
  "input",
  "timestamp",
  "error",
  "error_code",
  "warning",
  // Our own hash, written by the adapter on the way in. Reading it back as source data
  // would hash a hash, and worse, would make the evolver a route by which seller-derived
  // data re-enters a pipeline built to keep it out.
  "sellerKey",
]);

export function inferAliases(
  cap: Capture,
  knownRefs: readonly string[],
  store: AliasStore = aliasStore()
): AliasChange[] {
  const known = knownRawFields(cap.source, store);
  const out: AliasChange[] = [];
  if (cap.rows.length === 0) return out;

  const rawNames = new Set<string>();
  for (const row of cap.rows) for (const k of Object.keys(row)) rawNames.add(k);

  for (const canonical of canonicalFields(cap.source, store)) {
    if (NEVER_LEARN_INTO.has(canonical)) continue;
    if (!INFERABLE.has(canonical)) continue;
    const shape = SHAPE[canonical];
    if (shape === undefined) continue;

    // Only consider a canonical field the adapter currently cannot read at all. An
    // alias that fills a null is reversible; one that competes with a working name is
    // not, and is left to a person.
    const resolved = cap.rows.filter((r) => pick(cap.source, canonical, r, store) !== null).length;
    if (resolved > 0) continue;

    for (const raw of rawNames) {
      if (known.has(raw) || NEVER_MAP.has(raw)) continue;
      // Anything that looks like it carries a person's name is off limits as a source,
      // not only as a target. A collector that starts calling the seller `vendor_handle`
      // must be handled by someone who can think about it.
      if (/seller|vendor|merchant|shop_name|user/i.test(raw)) continue;
      const present = cap.rows.filter((r) => r[raw] !== undefined && r[raw] !== null);
      if (present.length < cap.rows.length) continue; // must be on every row
      const fits = present.filter((r) => shape(r[raw])).length;
      if (fits !== present.length) continue;

      // For an identifier, shape is not enough: it has to be the identifier we already
      // know, or a rename could quietly re-key the whole feed.
      let extra = "";
      if (canonical === "id" || canonical === "ref") {
        if (knownRefs.length === 0) continue;
        const overlap = present.filter((r) => knownRefs.includes(String(r[raw]).trim())).length;
        if (overlap < present.length) continue;
        extra = `, and all ${overlap} matched refs already in the baseline`;
      }

      out.push({
        kind: "alias",
        what: `${cap.source}: read "${raw}" as ${canonical}`,
        evidence:
          `${cap.label}: ${canonical} resolved to null on all ${cap.rows.length} rows, ` +
          `while "${raw}" was present on every row and ${fits}/${present.length} values ` +
          `fit the expected shape${extra}`,
        source: cap.source,
        canonical,
        raw,
      });
    }
  }
  return out;
}

// --- applying ----------------------------------------------------------------

export function applyAlias(store: AliasStore, c: AliasChange, now: string): AliasStore {
  // The runtime guard that used to stand here checked that this was an alias change
  // carrying a canonical field and a raw name. The type says so now, so a change that
  // does not is not constructible and the check had nothing left to catch.
  const next: AliasStore = JSON.parse(JSON.stringify(store)) as AliasStore;
  const forSource = (next.sources[c.source] ??= {});
  const list = (forSource[c.canonical] ??= []);
  if (list.includes(c.raw)) return store;
  // Appended, never prepended. An existing name keeps its precedence, so applying this
  // cannot change a value the engine already reads.
  list.push(c.raw);
  next.log.push({
    at: now,
    source: c.source,
    canonical: c.canonical,
    raw: c.raw,
    collectorId: c.collectorId ?? null,
    evidence: c.evidence,
    applied: true,
    reversible: true,
    by: "evolve",
  });
  return next;
}

// --- evidence gathering ------------------------------------------------------

function loadCaptures(): Capture[] {
  const dir = join(ROOT, "engine", "samples");
  if (!existsSync(dir)) return [];
  const out: Capture[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const source = f.startsWith("tradewell") ? "tradewell" : f.startsWith("arcadia") ? "arcadia" : null;
    if (source === null) continue;
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    const rows = (Array.isArray(raw) ? raw : []).flatMap((r) => {
      if (typeof r !== "object" || r === null) return [];
      const nested = (r as { results?: unknown }).results;
      return Array.isArray(nested) ? (nested as Record<string, unknown>[]) : [r as Record<string, unknown>];
    });
    out.push({ label: f, source, rows });
  }
  return out;
}

function loadIncidents(): { cause: string; evidence: string[]; prompt: string | null; verified: boolean }[] {
  const dir = join(ROOT, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("incident-") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { incident: Record<string, unknown> })
    .map((d) => ({
      cause: String(d.incident.cause ?? ""),
      evidence: (d.incident.evidence as string[] | undefined) ?? [],
      prompt: (d.incident.prompt as string | null | undefined) ?? null,
      verified: Boolean(d.incident.verified) && Boolean(d.incident.healAttempted),
    }));
}

function knownRefsFor(source: string): string[] {
  const p = join(ROOT, "runs", `state-${source}.json`);
  if (!existsSync(p)) return [];
  const s = JSON.parse(readFileSync(p, "utf8")) as { baselineRefs?: string[] };
  return s.baselineRefs ?? [];
}


/** Phrase counts written by the oracle. Absent on a fresh clone, which is not an error:
 *  it means nothing has been probed yet and there is nothing to learn from. */
function loadLedger(): PhraseLedger {
  const p = join(ROOT, "engine", "learned", "gone-candidates.json");
  if (!existsSync(p)) return emptyLedger();
  return JSON.parse(readFileSync(p, "utf8")) as PhraseLedger;
}

function gatherEvidence(): Evidence {
  const incidents = loadIncidents();
  const captures: LearnerCapture[] = loadCaptures();
  const heals: HealRecord[] = incidents.map((i) => ({
    cause: i.cause,
    prompt: i.prompt,
    verified: i.verified,
  }));
  return {
    captures,
    heals,
    ledger: loadLedger(),
    knownMarkers: GONE_MARKERS,
    knownRefsFor,
  };
}

// --- cli ---------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const acceptAt = argv.indexOf("--accept");
  const accept = acceptAt === -1 ? null : Number(argv[acceptAt + 1]);
  const now = new Date().toISOString();

  const evidence = gatherEvidence();

  // Every learner sees the same evidence and none of them decides what happens next.
  // Adding one is an entry in the registry; nothing here needs to know it exists.
  const found: AnyChange[] = [];
  for (const learner of LEARNERS) {
    for (const c of learner.propose(evidence)) found.push(c);
  }

  const seen = new Set<string>();
  const unique = found.filter((c) => {
    const k = changeKey(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const { auto, proposed } = partition(unique);

  console.log("");
  console.log(
    `  evidence: ${evidence.captures.length} capture(s), ${evidence.heals.length} incident(s), ` +
      `${Object.keys(evidence.ledger.sources).length} source(s) with observed page phrases`
  );
  for (const l of LEARNERS) console.log(`    ${l.id.padEnd(15)} ${l.learns}`);
  console.log("");

  if (accept !== null) {
    const c = proposed[accept - 1];
    if (c === undefined) {
      console.error(`  no proposal ${accept}. There are ${proposed.length}.`);
      process.exit(2);
    }
    console.log(`  accepting proposal ${accept} is a manual edit: ${c.what}`);
    console.log(`  ${c.evidence}`);
    console.log("  Nothing here edits a gate on your behalf. Make the change and commit it.");
    return;
  }

  let store = aliasStore();
  let applied = 0;
  for (const c of auto) {
    // `auto` can only contain kinds the policy cleared, and the only such kind is an
    // alias. The check is here so that a future learner whose kind is cleared by mistake
    // fails loudly rather than falling through to a store write that does nothing.
    if (c.kind !== "alias") throw new Error(`policy cleared ${c.kind} for unattended apply, but nothing applies it`);
    const before = JSON.stringify(store);
    store = applyAlias(store, c, now);
    if (JSON.stringify(store) !== before) {
      applied++;
      console.log(`  APPLIED   ${c.what}`);
      console.log(`            ${c.evidence}`);
      console.log(`            ${mayApplyUnattended(c).because}`);
      console.log("");
    }
  }

  if (applied > 0 && !dry) {
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + "\n");
  }

  for (const [n, c] of proposed.entries()) {
    console.log(`  PROPOSED  ${n + 1}. ${c.what}`);
    console.log(`            ${c.evidence}`);
    console.log(`            not applied: ${mayApplyUnattended(c).because}`);
    console.log("");
  }

  if (!dry) {
    writeFileSync(PROPOSALS_PATH, JSON.stringify({ at: now, proposals: proposed }, null, 2) + "\n");
  }

  console.log(
    `  ${applied} applied, ${proposed.length} proposed${dry ? "  (dry run, nothing written)" : ""}`
  );
  if (applied === 0 && proposed.length === 0) {
    console.log("  Nothing to learn from the evidence on hand.");
  }
  console.log("");
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("evolve.ts")) main();

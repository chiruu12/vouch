// A source contract, and the check that decides whether a probe satisfied it.
//
// Three counters, deliberately only three. Anything cleverer (distribution shift,
// cardinality collapse, markup fingerprints) was cut: it costs build time and adds
// false positives, and on this data the cheap counters catch what matters.
//
//   1. null rate per field   a field that used to be populated and now is not
//   2. type flips            a field that parses as the wrong shape
//   3. row-count cliff       the listing returning far fewer rows than last time
//
// A contract failing is NOT a diagnosis. It says "something is wrong here", and
// hands off to classify.ts to work out which of the four causes it is. Keeping
// detection and diagnosis apart is what stops us healing a withdrawn recall.

import type { SourceId } from "./types.js";

export type FieldType = "string" | "date" | "enum" | "number";

export interface FieldRule {
  type: FieldType;
  /** Fraction of rows allowed to be null before this field counts as breached.
   *  Set from observed reality, not aspiration: some regulators genuinely omit
   *  fields on some notices, and a contract that cries wolf gets ignored. */
  maxNullRate: number;
  /** Permitted values for `enum` fields. */
  values?: readonly string[];
  /** Shortest string we will accept as a real value. Catches the common failure
   *  where a selector still matches but yields "" or whitespace. */
  minLength?: number;
}

export interface SourceContract {
  version: string;
  sourceId: SourceId;
  /** Below this many rows we treat the run as failed rather than merely quiet. */
  minRows: number;
  /** Row count dropping by more than this fraction against the last good run is
   *  a cliff. Withdrawals are normal and gradual; a cliff is structural. */
  maxRowDropRate: number;
  fields: Record<string, FieldRule>;
}

export interface FieldReport {
  field: string;
  nullRate: number;
  nullRateLimit: number;
  typeErrors: number;
  breached: boolean;
  /** Refs of a few offending rows. These go into the heal prompt as evidence,
   *  which is the difference between "price is broken" and a bug report. */
  sampleRefs: string[];
}

export interface ContractReport {
  sourceId: SourceId;
  contractVersion: string;
  at: string;
  rows: number;
  /** Rows in the last run that passed, if we have one. */
  baselineRows: number | null;
  /** Positive means we lost rows. Null when there is no baseline yet. */
  rowDropRate: number | null;
  passed: boolean;
  /** Short human-readable statements, used verbatim in the incident timeline. */
  breaches: string[];
  fields: FieldReport[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isNullish(v: unknown, rule: FieldRule): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return true;
    if (rule.minLength !== undefined && t.length < rule.minLength) return true;
  }
  return false;
}

/** Does the value parse as the declared type? Only called on non-null values. */
function isTypeError(v: unknown, rule: FieldRule): boolean {
  switch (rule.type) {
    case "string":
      return typeof v !== "string";
    case "date":
      // We require normalised ISO date-only. Adapters do the reformatting, so a
      // long-form date arriving here means an adapter stopped normalising, which
      // is exactly the kind of silent drift we care about.
      return typeof v !== "string" || !ISO_DATE.test(v);
    case "enum":
      return typeof v !== "string" || !(rule.values ?? []).includes(v);
    case "number":
      // A price arriving as the string "1,099.99" means the adapter stopped parsing,
      // which is the same class of silent drift as a date arriving unformatted.
      return typeof v !== "number" || !Number.isFinite(v);
  }
}

/** How a row identifies itself in breach evidence. Recall notices carry `ref`;
 *  marketplace listings carry `id`. Sample refs end up quoted into heal prompts, so
 *  a source whose rows key on something else has to say so rather than silently
 *  reporting a column of empty strings. */
export type RefOf = (row: Record<string, unknown>) => string;

const defaultRefOf: RefOf = (row) => {
  const v = row.ref;
  return typeof v === "string" ? v : "";
};

export function checkContract(
  contract: SourceContract,
  // `object` rather than a Record: an interface like Listing has no implicit index
  // signature, so a Record parameter would reject the very rows we need to check.
  rows: readonly object[],
  baselineRows: number | null,
  now: () => Date = () => new Date(),
  refOf: RefOf = defaultRefOf
): ContractReport {
  const breaches: string[] = [];
  const fields: FieldReport[] = [];
  const n = rows.length;

  for (const [field, rule] of Object.entries(contract.fields)) {
    let nulls = 0;
    let typeErrors = 0;
    const sampleRefs: string[] = [];

    for (const row of rows) {
      const record = row as unknown as Record<string, unknown>;
      const value = record[field];
      if (isNullish(value, rule)) {
        nulls++;
        if (sampleRefs.length < 3) sampleRefs.push(refOf(record));
      } else if (isTypeError(value, rule)) {
        typeErrors++;
        if (sampleRefs.length < 3) sampleRefs.push(refOf(record));
      }
    }

    const nullRate = n === 0 ? 1 : nulls / n;
    const breached = nullRate > rule.maxNullRate || typeErrors > 0;
    fields.push({
      field,
      nullRate,
      nullRateLimit: rule.maxNullRate,
      typeErrors,
      breached,
      sampleRefs,
    });

    // Breach PROSE is suppressed on an empty extraction; the field report above is not.
    //
    // A null rate over no rows is not a measurement. `nullRate` is 1 by the line above
    // because the denominator is empty, so every field breaches at once and an extraction
    // that returned nothing produced one sentence per field before it got to the sentence
    // that says what actually happened. Seven of them for eBay, then "returned 0 rows".
    //
    // The field entries keep `breached: true` deliberately. `deriveTrust` reads them to
    // decide whether a volume drop is explained by withdrawals, and an empty extraction is
    // emphatically not explained by anything. Suppressing the prose changes what we say,
    // not what we conclude.
    if (n > 0 && nullRate > rule.maxNullRate) {
      breaches.push(
        `field ${field} null rate ${pct(nullRate)} exceeds limit ${pct(rule.maxNullRate)} over ${n} rows`
      );
    }
    if (typeErrors > 0) {
      breaches.push(
        `field ${field} failed ${rule.type} parsing on ${typeErrors} of ${n} rows`
      );
    }
  }

  if (n < contract.minRows) {
    breaches.push(`returned ${n} rows, contract requires at least ${contract.minRows}`);
  } else if (n === 0 && Object.keys(contract.fields).length > 0) {
    // Only reachable on a contract with `minRows: 0`, and it is the reason the field
    // prose above could be suppressed safely. Without this, a contract that tolerates a
    // quiet week would report an extraction of nothing as clean, because the only thing
    // that used to fail it was the per-field noise this change removed.
    breaches.push("returned 0 rows and every contracted field is therefore unmeasurable");
  }

  let rowDropRate: number | null = null;
  if (baselineRows !== null && baselineRows > 0) {
    rowDropRate = (baselineRows - n) / baselineRows;
    if (rowDropRate > contract.maxRowDropRate) {
      breaches.push(volumeBreach(baselineRows, n, contract.maxRowDropRate));
    }
  }

  return {
    sourceId: contract.sourceId,
    contractVersion: contract.version,
    at: now().toISOString(),
    rows: n,
    baselineRows,
    rowDropRate,
    passed: breaches.length === 0,
    breaches,
    fields,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** The sentence a volume cliff produces, exported so nothing has to reproduce it.
 *
 *  The demo and the agent view illustrate a broken source by constructing a breach, and
 *  they used to write that sentence out by hand. It drifted: they emitted "row count fell
 *  31.0% against a baseline of 29", a grammar this function has never produced, in a repo
 *  whose docs say every number came from a real run. An illustration is allowed to be
 *  constructed, but not to be a shape the engine cannot emit, because then a reader
 *  checking it against the incident log finds nothing and cannot tell which one is lying.
 *  Calling this is now the only way to say it. */
export function volumeBreach(baselineRows: number, n: number, maxRowDropRate: number): string {
  const rate = (baselineRows - n) / baselineRows;
  return `row count fell from ${baselineRows} to ${n}, a ${pct(rate)} drop, limit ${pct(maxRowDropRate)}`;
}

// --- the Arcadia fixture contract -------------------------------------------
// Every field is mandatory on this source because we generate the data, so any
// null at all is drift rather than a genuinely absent value. Real regulators get
// looser limits.

export const ARCADIA_CONTRACT: SourceContract = {
  version: "arcadia@1",
  sourceId: "arcadia",
  minRows: 10,
  maxRowDropRate: 0.2,
  fields: {
    ref: { type: "string", maxNullRate: 0, minLength: 8 },
    title: { type: "string", maxNullRate: 0, minLength: 8 },
    brand: { type: "string", maxNullRate: 0, minLength: 2 },
    hazard: { type: "string", maxNullRate: 0, minLength: 12 },
    risk: { type: "enum", maxNullRate: 0, values: ["Serious", "High", "Medium", "Low"] },
    category: { type: "string", maxNullRate: 0, minLength: 4 },
    affectedUnits: { type: "string", maxNullRate: 0, minLength: 3 },
    published: { type: "date", maxNullRate: 0 },
    action: { type: "string", maxNullRate: 0, minLength: 10 },
  },
};

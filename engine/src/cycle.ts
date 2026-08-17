// The entry point. Builds real CycleDeps out of the Bright Data CLI and runs one
// supervision cycle against a live collector.
//
// Until now `runCycle` was fully tested and never actually connected to anything: the
// deps were injected in tests and nothing in the repo supplied the real ones. This is
// that wiring, and it is deliberately thin. Everything worth arguing about lives in
// contract.ts, classify.ts and prompt.ts, which are pure and tested. A cycle entry
// point that also contained judgement would put untested judgement on the live path.
//
//   node --import tsx src/cycle.ts arcadia
//   node --import tsx src/cycle.ts tradewell --url https://tradewell-market.vercel.app/page-1.html
//
// State persists to runs/state-<source>.json between invocations. Without a baseline
// the classifier cannot tell a withdrawal from an extraction loss, so the first run of
// any source is only ever a baseline: it records what it saw and diagnoses nothing.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { healScraper, probePermalinks, probeUrl, runScraper } from "./bdata.js";
import { ARCADIA_CONTRACT, type SourceContract } from "./contract.js";
import type { ListingProbe } from "./classify.js";
import type { MarkupObservation } from "./prompt.js";
import { emptyState, runCycle, type CycleDeps, type Row, type SourceState } from "./runner.js";
import { normaliseArcadia } from "./sources/arcadia.js";
import { TRADEWELL_CONTRACT, normaliseTradewell } from "./sources/tradewell.js";
import type { SourceId } from "./types.js";

// --- what a source needs in order to be supervised -------------------------

interface SourceWiring {
  collectorId: string;
  url: string;
  contract: SourceContract;
  /** Raw collector output into the canonical shape the contract is written against.
   *  This is the seam that was missing: without it the contract compares its own field
   *  names to the collector's and reports every field as null on healthy data. */
  normalise(raw: unknown): Row[];
  /** How a row names itself. */
  refOf(row: Row): string;
  /** A ref's own page, used as the withdrawal oracle. Null when the source has none,
   *  which disables withdrawal detection rather than guessing at it. */
  permalinkFor(ref: string): string | null;
  rowsPerPage?: number;
  extraPaths?: readonly string[];
}

/** Rows are canonical by the time the engine sees them, so a ref lookup is a plain
 *  field read rather than an alias search. The aliasing lives in the adapters. */
function str(row: Row, name: string): string {
  const v = row[name];
  return typeof v === "string" ? v.trim() : "";
}

const SOURCES: Partial<Record<SourceId, SourceWiring>> = {
  arcadia: {
    collectorId: "c_msx7z3xi2hs08ccwms",
    url: "https://arcadia-safety.vercel.app/",
    contract: ARCADIA_CONTRACT,
    normalise: (raw) => normaliseArcadia(raw) as unknown as Row[],
    refOf: (row) => str(row, "ref"),
    permalinkFor: (ref) => `https://arcadia-safety.vercel.app/notice/${ref}.html`,
    rowsPerPage: 6,
    extraPaths: ["/page-2.html"],
  },
  tradewell: {
    // Filled in by the create call; see runs/create-tradewell.json.
    collectorId: process.env.TRADEWELL_COLLECTOR ?? "c_msxhnjyoflutq9tt8",
    url: "https://tradewell-market.vercel.app/",
    contract: TRADEWELL_CONTRACT,
    normalise: (raw) => normaliseTradewell(raw) as unknown as Row[],
    refOf: (row) => str(row, "id"),
    permalinkFor: (ref) => `https://tradewell-market.vercel.app/item/${ref}.html`,
    rowsPerPage: 7,
    extraPaths: ["/page-2.html"],
  },
};

// --- live deps -------------------------------------------------------------

/** Signatures that mean "we were served a wall, not the page". Checked on a 200,
 *  because the dangerous block is the one that does not announce itself with a 4xx.
 *  Our own blocked fixture returns 200 with an interstitial for exactly this reason. */
const BLOCK_MARKERS = [
  "verify you are a human",
  "are you a robot",
  "unusual traffic",
  "access denied",
  "enable javascript and cookies",
  "checking your browser",
];

function detectBlock(body: string): string | null {
  const hay = body.toLowerCase();
  for (const m of BLOCK_MARKERS) {
    if (hay.includes(m)) return m;
  }
  return null;
}

/** What the live page looks like now, in the terms the heal prompt speaks. Cheap
 *  string scanning, not a DOM: the prompt only needs hooks and labels to quote. */
function observeMarkup(body: string, contract: SourceContract): MarkupObservation {
  const hooks = new Set<string>();
  for (const m of body.matchAll(/\b(data-[a-z0-9-]+)=/gi)) {
    if (m[1]) hooks.add(m[1].toLowerCase());
  }

  const labels = new Set<string>();
  for (const m of body.matchAll(/<dt[^>]*>([^<]{2,40})<\/dt>/gi)) {
    if (m[1]) labels.add(m[1].trim());
  }
  for (const m of body.matchAll(/<th[^>]*>([^<]{2,40})<\/th>/gi)) {
    if (m[1]) labels.add(m[1].trim());
  }

  // A contract field whose name appears nowhere in the document is the closest thing
  // to a dead selector we can report without keeping the old selectors around.
  const dead: string[] = [];
  const hay = body.toLowerCase();
  for (const field of Object.keys(contract.fields)) {
    const word = field.replace(/[_-]/g, " ").toLowerCase();
    if (!hay.includes(word) && !hay.includes(field.toLowerCase())) dead.push(`.${field}`);
  }

  return {
    listingStatus: 200,
    listingBytes: body.length,
    deadSelectors: dead.slice(0, 3),
    observedHooks: [...hooks].slice(0, 8),
    observedLabels: [...labels].slice(0, 8),
  };
}

function makeDeps(normalise: (raw: unknown) => Row[]): CycleDeps {
  return {
  async probeListing(url: string): Promise<ListingProbe> {
    const probe = await probeUrl(url);
    return {
      status: probe.status,
      bodyBytes: probe.bytes,
      blockSignature: detectBlock(probe.body),
      body: probe.body,
    };
  },
  async runScraper(collectorId, url) {
    // A failed run is data, not an exception. Measured against the blocked fixture: the
    // sync endpoint times out server-side after 50s while the scraper sits on an
    // interstitial, and the CLI exits non-zero. Letting that throw crashed the cycle
    // before the classifier could call it "blocked", losing one of the two refusal paths
    // at exactly the moment it matters. probeListing has already recorded the block
    // signature by this point, so returning zero rows lets classify() reach the right
    // verdict instead of the process dying.
    let result;
    try {
      result = await runScraper(collectorId, url);
    } catch (e) {
      return { rows: [], errors: [{ error: e instanceof Error ? e.message : String(e) }] };
    }

    // Normalise here, so everything downstream of this line speaks one vocabulary.
    // Rows the adapter rejects are counted as errors rather than silently vanishing:
    // an unparseable row is a contract signal, not nothing.
    const rows = normalise(result.rows);
    const dropped = result.rows.length - rows.length;
    return {
      rows,
      errors: dropped > 0 ? [...result.errors, { error: `${dropped} row(s) failed to normalise` }] : result.errors,
    };
  },
  probePermalinks: (entries) => probePermalinks(entries),
  async heal(collectorId, prompt, url) {
    const r = await healScraper(collectorId, prompt, url);
    return { ok: r.ok, durationMs: r.durationMs, status: r.status };
  },
  observeMarkup,
  now: () => new Date(),
  };
}

// --- state -----------------------------------------------------------------

function statePath(sourceId: string): string {
  return resolve(process.cwd(), "..", "runs", `state-${sourceId}.json`);
}

function loadState(sourceId: string): SourceState {
  try {
    return JSON.parse(readFileSync(statePath(sourceId), "utf8")) as SourceState;
  } catch {
    return emptyState();
  }
}

function saveState(sourceId: string, state: SourceState): void {
  const p = statePath(sourceId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
}

// --- main ------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const sourceId = process.argv[2] as SourceId | undefined;
  if (sourceId === undefined || SOURCES[sourceId] === undefined) {
    console.error(`usage: node --import tsx src/cycle.ts <${Object.keys(SOURCES).join("|")}> [--url URL]`);
    process.exit(2);
  }

  const wiring = SOURCES[sourceId]!;
  const collectorId = arg("collector") ?? wiring.collectorId;
  if (collectorId === "") {
    console.error(`no collector id for ${sourceId}. Pass --collector c_... or set the env var.`);
    process.exit(2);
  }

  const url = arg("url") ?? wiring.url;
  const state = loadState(sourceId);
  const firstRun = state.baselineRefs.length === 0;

  console.log(`source      ${sourceId}`);
  console.log(`collector   ${collectorId}`);
  console.log(`url         ${url}`);
  console.log(`baseline    ${firstRun ? "none (this run establishes it)" : `${state.baselineRefs.length} refs`}`);
  console.log("");

  const started = Date.now();
  const result = await runCycle(
    {
      sourceId,
      collectorId,
      url,
      contract: wiring.contract,
      state,
      permalinkFor: wiring.permalinkFor,
      refOf: wiring.refOf,
      ...(wiring.rowsPerPage !== undefined ? { rowsPerPage: wiring.rowsPerPage } : {}),
      ...(wiring.extraPaths !== undefined ? { extraPaths: wiring.extraPaths } : {}),
    },
    makeDeps(wiring.normalise)
  );

  const { report, diagnosis, incident, serving } = result;

  console.log(`rows        ${report.rows}${report.baselineRows === null ? "" : ` (baseline ${report.baselineRows})`}`);
  console.log(`contract    ${report.contractVersion} ${report.passed ? "PASSED" : "FAILED"}`);
  for (const b of report.breaches) console.log(`  breach     ${b}`);
  console.log(`diagnosis   ${diagnosis.cause}${diagnosis.healable ? " (healable)" : " (not healable)"}`);
  for (const e of diagnosis.evidence) console.log(`  evidence   ${e}`);

  if (diagnosis.withdrawnRefs.length > 0) {
    console.log(`withdrawn   ${diagnosis.withdrawnRefs.join(", ")}`);
  }

  if (incident !== null) {
    console.log("");
    if (incident.refusal !== null) console.log(`REFUSED     ${incident.refusal}`);
    if (incident.healAttempted) {
      console.log(`healed      ${incident.healDurationMs}ms, verified=${incident.verified}`);
      console.log(`prompt      ${incident.prompt}`);
    }
    if (incident.mttrMs !== null) console.log(`MTTR        ${(incident.mttrMs / 1000).toFixed(1)}s`);
  }

  console.log("");
  console.log(`SERVING     ${serving.rows.length} rows as "${serving.state}"`);
  console.log(`cycle took  ${((Date.now() - started) / 1000).toFixed(1)}s`);

  saveState(sourceId, result.nextState);

  const incidentPath = resolve(process.cwd(), "..", "runs", `incident-${sourceId}-${Date.now()}.json`);
  if (incident !== null) {
    writeFileSync(incidentPath, JSON.stringify({ incident, report, diagnosis }, null, 2) + "\n");
    console.log(`incident    ${incidentPath}`);
  }

  // Exit non-zero when we are not serving verified current data, so a scheduler or CI
  // step treats "quietly serving stale rows" as the failure it is.
  process.exit(serving.state === "verified" || serving.state === "healed" ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(3);
});

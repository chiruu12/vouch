// Thin wrapper over the Bright Data CLI (`bdata`, v0.3.5).
//
// Everything awkward in here is a real constraint we measured, not a preference.
// Recorded so nobody re-derives it at 2am:
//
//   Timings on a 12-record, 2-page listing:
//     scraper create   128s to 362s
//     scraper heal      90s and up; it loops code_fixer internally on retry
//     scraper run --sync  5s to 6s
//   All three were free. Account balance did not move across two creates, three
//   heals and seven runs. Only page loads bill, and at this volume they round to zero.
//
//   `scraper run --version dev` is UNREACHABLE from the CLI. The root command
//   defines a global `-v, --version`, which shadows the subcommand option, so
//   `--version dev` prints "0.3.5" and exits. This is why we cannot verify a heal
//   draft before it reaches production, and why the serving gate moved to the point
//   of serving instead. See runHealCycle.
//
//   `scraper approve --auto-save` on a heal that already auto-approved returns
//   HTTP 400 "Invalid ide automation". A heal cannot be saved retroactively, so
//   --auto-save must be passed on the heal call itself.
//
//   A second `scraper heal` against a collector whose previous heal auto-approved
//   can return HTTP 422 "Invalid message" with zero completed steps, leaving the
//   collector unable to accept further heals. Treat a wedged collector as a real
//   operational state, not a transient error.
//
//   Angle brackets in a heal prompt have produced HTTP 422 "Invalid message".
//   prompt.ts strips them. The prompt is also hard-capped at 1000 characters.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { visibleText } from "./html.js";

const exec = promisify(execFile);

/** `npx -p @brightdata/cli bdata ...`, so no global install is required. */
const BIN = "npx";
const BASE_ARGS = ["-p", "@brightdata/cli", "bdata"];

export interface RunResult {
  /** Rows with no `error` key. These are candidate records. */
  rows: Record<string, unknown>[];
  /** Rows carrying an `error`/`error_code`, e.g. dead_page. */
  errors: { error: string; error_code?: string }[];
  durationMs: number;
}

export interface HealResult {
  ok: boolean;
  status: string;
  completedSteps: string[];
  durationMs: number;
  error?: string;
}

export interface UrlProbe {
  status: number;
  bytes: number;
  body: string;
  /** Where the request actually landed, after redirects. Differs from the requested
   *  URL when a record's own page has been redirected somewhere else. */
  finalUrl: string;
}

function isErrorRow(r: unknown): r is { error: string; error_code?: string } {
  return typeof r === "object" && r !== null && "error" in r;
}

/**
 * Run a collector against one URL in sync mode.
 *
 * An EMPTY array is the signal we care about most: zero rows and zero errors means
 * the selectors matched nothing and the run reported success anyway. That is the
 * silent failure this project exists to catch, so it is returned as a normal result
 * rather than thrown.
 */
export async function runScraper(collectorId: string, url: string, timeoutMs = 120_000): Promise<RunResult> {
  const started = Date.now();
  const { stdout } = await exec(
    BIN,
    [...BASE_ARGS, "scraper", "run", collectorId, url, "--sync", "--json"],
    { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }
  );

  const parsed: unknown = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return {
    rows: list.filter((r): r is Record<string, unknown> => !isErrorRow(r)),
    errors: list.filter(isErrorRow),
    durationMs: Date.now() - started,
  };
}

/**
 * Heal a collector.
 *
 * `--auto-save` is not optional for us: without it the fix lands in a draft we have
 * no way to run (see the --version note above), so the heal would be unobservable.
 * The consequence is that a heal always reaches production, which is precisely why
 * the caller must verify afterwards and refuse to SERVE unverified output.
 */
export async function healScraper(
  collectorId: string,
  prompt: string,
  url: string,
  timeoutMs = 900_000
): Promise<HealResult> {
  const started = Date.now();
  if (prompt.length > 1000) {
    return {
      ok: false,
      status: "prompt_too_long",
      completedSteps: [],
      durationMs: 0,
      error: `prompt is ${prompt.length} chars, the API cap is 1000`,
    };
  }

  try {
    const { stdout } = await exec(
      BIN,
      [
        ...BASE_ARGS, "scraper", "heal", collectorId, prompt,
        "--url", url, "--auto-approve", "--auto-save",
        "--timeout", String(Math.floor(timeoutMs / 1000)), "--json",
      ],
      { timeout: timeoutMs + 30_000, maxBuffer: 32 * 1024 * 1024 }
    );

    const env = JSON.parse(stdout) as {
      status?: string;
      completed_steps?: string[];
      error?: string;
    };

    // "done" is the vendor's own verdict and we do not trust it. Heal 1 in our
    // measurements returned status "done" with a request_fulfillment_validator
    // step completed, while the collector still extracted zero rows. ok here means
    // "the heal call finished", never "the data is good".
    const status = env.status ?? "unknown";
    return {
      ok: status === "done",
      status,
      completedSteps: env.completed_steps ?? [],
      durationMs: Date.now() - started,
      ...(env.error !== undefined ? { error: env.error } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Heal is exclusive per collector. A second call while one is running returns
    // HTTP 409 "Another refactor job is still in progress" and the CLI exits non-zero,
    // which arrives here looking exactly like a failed repair. It is not: nothing was
    // attempted and the collector is untouched. Reporting it as a failure invites the
    // caller to escalate when the correct action is to wait, so it gets its own status.
    const busy = /another refactor job is still in progress|\b409\b/i.test(message);
    return {
      ok: false,
      status: busy ? "heal_busy" : "heal_call_failed",
      completedSteps: [],
      durationMs: Date.now() - started,
      error: message,
    };
  }
}

/** Statuses that mean "the site refused us", not "the record is gone".
 *
 *  This distinction is the whole reason the oracle needs a second transport. A real
 *  eBay item permalink answers 403 to a plain request, whatever user agent it carries.
 *  Left there, every missing row on a marketplace with a bot wall is unresolvable, the
 *  oracle can never establish a withdrawal, and the supervisor refuses every repair it
 *  is offered. That fails closed, which is correct and also useless: on the sites this
 *  project is actually for, it would never do anything at all. */
const REFUSED_STATUSES = new Set([401, 403, 407, 429, 503]);

/** Bright Data's own failure, reported in its headers rather than in the status line.
 *  A navigation timeout comes back as 502 with `x-brd-error`, and reading that as the
 *  target's answer would turn an infrastructure blip into a withdrawal. */
function brdError(headers: Record<string, unknown> | undefined): string | null {
  if (headers === undefined) return null;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-brd-error") return String(v);
  }
  return null;
}

/** The permalink oracle over the Web Unlocker API, used only when a plain request was
 *  refused. Returns null for "could not establish", never a guess.
 *
 *  Note the deliberate gap: the Unlocker reports status, headers and body, but not the
 *  URL it landed on, so `finalUrl` stays as asked and `redirectedAway` cannot fire on
 *  an unlocked probe. That only ever weakens withdrawal detection, so a record whose
 *  page now redirects elsewhere reads as unresolved rather than gone, and unresolved
 *  refuses the repair. Losing the redirect signal costs a refusal, not a phantom. */
export function readUnlockerEnvelope(stdout: string, url: string): UrlProbe | null {
  // The CLI prints a progress line before the envelope.
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  let env: { status_code?: number; headers?: Record<string, unknown>; body?: string };
  try {
    env = JSON.parse(stdout.slice(start)) as typeof env;
  } catch {
    return null;
  }
  if (typeof env.status_code !== "number") return null;
  if (brdError(env.headers) !== null) return null;
  // A 5xx from the proxy is the proxy's answer, not the site's.
  if (env.status_code >= 500) return null;
  const body = typeof env.body === "string" ? env.body : "";
  return { status: env.status_code, bytes: body.length, body, finalUrl: url };
}

async function probeViaUnlocker(url: string, timeoutMs: number): Promise<UrlProbe | null> {
  try {
    const { stdout } = await exec(BIN, [...BASE_ARGS, "scrape", url, "--format", "json"], {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return readUnlockerEnvelope(stdout, url);
  } catch {
    return null;
  }
}

/** The listing probe and the permalink oracle.
 *
 *  Plain fetch first, because it is free and instant and the sources that answer it
 *  honestly are most of them. Escalation to the Web Unlocker happens only when the
 *  site refused the plain request, so an ordinary cycle costs nothing extra and a
 *  hostile target still gets a real answer. */
export async function probeUrl(
  url: string,
  timeoutMs = 20_000,
  opts: { unlock?: boolean } = {}
): Promise<UrlProbe> {
  const direct = await plainProbe(url, timeoutMs);
  if (opts.unlock === false || !REFUSED_STATUSES.has(direct.status)) return direct;

  // Unlocker requests take a good deal longer than a plain fetch, so the escalation
  // gets its own floor rather than inheriting a timeout tuned for direct requests.
  const unlocked = await probeViaUnlocker(url, Math.max(timeoutMs, 90_000));

  // Falling back to `direct` on failure keeps the refusal visible: a block we could
  // not see past stays a block, and the classifier refuses on it exactly as before.
  return unlocked ?? direct;
}

async function plainProbe(url: string, timeoutMs: number): Promise<UrlProbe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const body = await res.text();
    return { status: res.status, bytes: body.length, body, finalUrl: res.url || url };
  } catch {
    // A transport failure is not a 404. Reporting 0 keeps the classifier from
    // mistaking a flaky network for a withdrawal, which would mark live notices
    // withdrawn and stop showing real recalls. The classifier treats 0 as
    // "could not establish", which refuses a repair rather than authorising one.
    return { status: 0, bytes: 0, body: "", finalUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

/** Phrases that mean "this record is gone" on a page that answered 200 anyway.
 *
 *  The mirror of BLOCK_MARKERS, and it exists for the same reason: the dangerous
 *  response is the one that does not announce itself in the status line. A site that
 *  serves a removed listing as a 200 "no longer available" page defeats a status-only
 *  oracle, and a status-only oracle then reports the record as merely lost, which is
 *  the one verdict that authorises a repair. Kept narrow on purpose: these phrases are
 *  unambiguous, and a false positive here marks a live record withdrawn. */
export const GONE_MARKERS = [
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

/** A permalink that answers 200 somewhere else is not evidence its own record exists.
 *
 *  Marketplaces routinely redirect an ended listing to a category page or a similar
 *  product. Following the redirect and reading 200 makes a removed record look alive,
 *  which files it as lost, which authorises a repair. Only a changed path counts:
 *  http to https, a host alias and a trailing slash are all the same page. */
export function redirectedAway(requested: string, landed: string): string | null {
  try {
    const a = new URL(requested);
    const b = new URL(landed);
    const norm = (p: string): string => p.replace(/\/+$/, "").toLowerCase();
    if (norm(a.pathname) === norm(b.pathname)) return null;
    return `permalink redirected to ${b.pathname}`;
  } catch {
    return null;
  }
}

export function detectGone(body: string): string | null {
  // Visible text only, and this is not a refinement. Matching these phrases against raw
  // HTML reads a site's embedded JSON string tables as if they were the page speaking: a
  // live eBay listing ships "remove_success_message":"The item has been removed" inside a
  // script tag, which contains this oracle's own marker. Every live listing on the site
  // matched, and a match here marks a live safety recall withdrawn and takes it off the
  // feed. The bug was unreachable only while a plain fetch was being refused with a 403,
  // and probing through the Unlocker made it reachable on the first real page.
  const hay = visibleText(body).toLowerCase();
  for (const m of GONE_MARKERS) {
    if (hay.includes(m)) return m;
  }
  return null;
}

/** Permalink liveness for a batch of refs. This is the withdrawal oracle.
 *
 *  Returns the status and, on a 200, whether the body says the record is gone anyway.
 *  A transport failure surfaces as status 0, which the classifier treats as "could not
 *  establish" rather than as either presence or absence. */
/** Told about each page as it is read, so something else can learn from it.
 *
 *  A callback rather than a direct call into the learner: this module's job is to ask a
 *  URL a question, and it should not also decide what is remembered or where. The
 *  observer sees the body because that is the only moment it exists; nothing here keeps
 *  it, and the learner that receives it extracts phrases and discards the page. */
export type PageObserver = (page: {
  ref: string;
  body: string;
  verdict: "gone" | "live" | "unresolved";
}) => void;

/** Which of the three a probe established. Deliberately not a boolean: "we could not
 *  tell" is a third answer and collapsing it into either of the others is how a block
 *  becomes a withdrawal or a withdrawal becomes noise in the live set. */
function verdictOf(status: number, goneSignature: string | null): "gone" | "live" | "unresolved" {
  if (status === 404 || status === 410) return "gone";
  if (status === 200) return goneSignature === null ? "live" : "gone";
  return "unresolved";
}

export async function probePermalinks(
  entries: readonly { ref: string; url: string }[],
  concurrency = 4,
  observe?: PageObserver
): Promise<{ ref: string; status: number; goneSignature: string | null }[]> {
  const out: { ref: string; status: number; goneSignature: string | null }[] = [];
  const queue = [...entries];

  async function worker(): Promise<void> {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      const probe = await probeUrl(next.url);
      const goneSignature =
        probe.status === 200
          ? (detectGone(probe.body) ?? redirectedAway(next.url, probe.finalUrl))
          : null;
      out.push({ ref: next.ref, status: probe.status, goneSignature });
      observe?.({ ref: next.ref, body: probe.body, verdict: verdictOf(probe.status, goneSignature) });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return out;
}

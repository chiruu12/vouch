// Thin wrapper over the Bright Data CLI (`bdata`, v0.3.5).
//
// Everything awkward in here is a real constraint we measured, not a preference.
// Recorded so nobody re-derives it at 2am:
//
//   Timings on a 12-record, 2-page listing:
//     scraper create   128s to 306s
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
    return {
      ok: false,
      status: "heal_call_failed",
      completedSteps: [],
      durationMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Plain fetch used for the listing probe and the permalink oracle. */
export async function probeUrl(url: string, timeoutMs = 20_000): Promise<UrlProbe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const body = await res.text();
    return { status: res.status, bytes: body.length, body };
  } catch {
    // A transport failure is not a 404. Reporting 0 keeps the classifier from
    // mistaking a flaky network for a withdrawal, which would mark live notices
    // withdrawn and stop showing real recalls.
    return { status: 0, bytes: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Permalink liveness for a batch of refs. This is the withdrawal oracle. */
export async function probePermalinks(
  entries: readonly { ref: string; url: string }[],
  concurrency = 4
): Promise<{ ref: string; status: number }[]> {
  const out: { ref: string; status: number }[] = [];
  const queue = [...entries];

  async function worker(): Promise<void> {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      const probe = await probeUrl(next.url);
      out.push({ ref: next.ref, status: probe.status });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return out;
}

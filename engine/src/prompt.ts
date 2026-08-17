// Turns a diagnosis into the prompt we hand `bdata scraper heal`.
//
// This is the difference between a human typing "price is broken" and handing the
// repair AI a bug report: what the numbers were, what they are now, what we ruled
// out and why, and what the live markup looks like today. Bright Data's healer is
// good and under-fed. We feed it.
//
// The guard at the top is the point of the file. A prompt is never produced for a
// blocked source (healing cannot clear a block) or a withdrawn notice (healing
// invents a replacement and republishes a phantom recall). The refusal lives here,
// in code, not in a convention someone remembers to follow.
//
// Two hard-won constraints from the live API:
//   - the prompt is capped at 1000 characters and is rejected outright above it
//   - angle brackets in the prompt have produced HTTP 422 "Invalid message", so we
//     strip them and describe markup in CSS-selector form instead

import type { Diagnosis } from "./classify.js";
import type { ContractReport } from "./contract.js";

export interface MarkupObservation {
  listingStatus: number;
  listingBytes: number;
  /** Selectors the working scraper relied on that now match nothing. */
  deadSelectors: string[];
  /** Attribute hooks present in the live document that look like field carriers. */
  observedHooks: string[];
  /** Visible field labels, for pages that use definition lists or similar. */
  observedLabels: string[];
}

export interface SynthesiseArgs {
  diagnosis: Diagnosis;
  report: ContractReport;
  markup: MarkupObservation;
  targetUrl: string;
  /** Additional listing paths the scraper must still cover, e.g. ["/page-2.html"]. */
  extraPaths?: readonly string[];
  maxChars?: number;
}

export class NotHealableError extends Error {
  constructor(readonly cause_: Diagnosis["cause"], readonly why: string) {
    super(`refusing to synthesise a heal prompt for cause "${cause_}": ${why}`);
    this.name = "NotHealableError";
  }
}

const MAX_CHARS = 1000;

/** The API rejects angle brackets. Describe markup as selectors instead. */
function sanitise(s: string): string {
  return s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

export function synthesiseHealPrompt(args: SynthesiseArgs): string {
  const { diagnosis, report, markup, targetUrl } = args;
  const limit = args.maxChars ?? MAX_CHARS;

  // The refusal. Not advisory.
  if (diagnosis.cause === "blocked") {
    throw new NotHealableError(
      "blocked",
      "the source refused the request; rewriting selectors cannot clear a block and burns credits pretending it can"
    );
  }
  if (diagnosis.cause === "gone") {
    throw new NotHealableError(
      "gone",
      "the notice was withdrawn and its permalink no longer resolves; healing here fabricates a replacement and republishes a phantom safety recall"
    );
  }
  if (diagnosis.cause === "healthy") {
    throw new NotHealableError("healthy", "nothing is broken");
  }
  if (!diagnosis.healable) {
    throw new NotHealableError(diagnosis.cause, "classifier marked this diagnosis unhealable");
  }

  // Ordered by how much it helps the repair. Later clauses get dropped first when
  // we run against the character cap.
  const clauses: string[] = [];

  // 1. What changed, numerically.
  if (report.rows === 0) {
    clauses.push(
      `Extraction returned an empty array: 0 rows where ${report.baselineRows ?? "several"} were expected, and no errors were raised.`
    );
  } else {
    const breached = report.fields.filter((f) => f.breached);
    const named = breached
      .slice(0, 4)
      .map((f) => `${f.field} (${(f.nullRate * 100).toFixed(0)}% null)`)
      .join(", ");
    // Every field can be intact while the run still breaches: a pagination change
    // drops whole rows and leaves the ones it did read perfect. Naming zero fields
    // after a colon produced "breached contract tradewell@1: ." and told the healer
    // nothing, so the row shortfall is stated instead, which is the actual symptom.
    clauses.push(
      named === ""
        ? `Extraction returned ${report.rows} rows against a baseline of ` +
            `${report.baselineRows ?? "more"}, and every field it did read satisfied ` +
            `contract ${report.contractVersion}. Rows are missing, not fields.`
        : `Extraction returned ${report.rows} rows but these fields breached contract ` +
            `${report.contractVersion}: ${named}.`
    );
  }

  // 2. What we ruled out. This is what stops the healer from guessing wrong.
  clauses.push(
    `The listing at ${targetUrl} still returns HTTP ${markup.listingStatus} with ${markup.listingBytes} bytes, so it is not blocked.`
  );
  if (diagnosis.withdrawnRefs.length === 0) {
    clauses.push(
      `Permalinks for the previously extracted notices still return HTTP 200, so nothing was withdrawn.`
    );
  } else {
    clauses.push(
      `${diagnosis.withdrawnRefs.length} notice(s) were withdrawn and are excluded from this repair; do not attempt to recover them.`
    );
  }

  // 3. What the page looks like now.
  if (markup.deadSelectors.length > 0) {
    clauses.push(
      `The previously working selector ${sanitise(markup.deadSelectors[0]!)} now matches 0 elements.`
    );
  }
  if (markup.observedHooks.length > 0) {
    clauses.push(`Attribute hooks present in the live document: ${markup.observedHooks.map(sanitise).join(", ")}.`);
  }
  if (markup.observedLabels.length > 0) {
    clauses.push(`Visible field labels are now: ${markup.observedLabels.map(sanitise).join(", ")}.`);
  }

  // 4. The instruction.
  const paths = args.extraPaths ?? [];
  clauses.push(
    paths.length > 0
      ? `Re-extract every notice across ${targetUrl} and ${paths.join(", ")}.`
      : `Re-extract every notice from ${targetUrl}.`
  );

  return fitToLimit(clauses, limit);
}

/** Keep the first clause and the last (the instruction), drop from the middle
 *  outwards until it fits. A prompt that loses its instruction is useless. */
function fitToLimit(clauses: string[], limit: number): string {
  const parts = clauses.map(sanitise);
  let working = [...parts];

  while (working.join(" ").length > limit && working.length > 2) {
    // Drop the second-to-last clause: least load-bearing, never the instruction.
    working.splice(working.length - 2, 1);
  }

  let out = working.join(" ");
  if (out.length > limit) out = `${out.slice(0, limit - 1)}.`;
  return out;
}

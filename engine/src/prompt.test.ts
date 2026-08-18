import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Diagnosis } from "./classify.js";
import type { ContractReport, FieldReport } from "./contract.js";
import {
  NotHealableError,
  synthesiseHealPrompt,
  type MarkupObservation,
  type SynthesiseArgs,
} from "./prompt.js";

function field(
  overrides: {
    field?: string;
    nullRate?: number;
    nullRateLimit?: number;
    typeErrors?: number;
    breached?: boolean;
    sampleRefs?: string[];
  } = {}
): FieldReport {
  return {
    field: overrides.field ?? "title",
    nullRate: overrides.nullRate ?? 0,
    nullRateLimit: overrides.nullRateLimit ?? 0,
    typeErrors: overrides.typeErrors ?? 0,
    breached: overrides.breached ?? false,
    sampleRefs: overrides.sampleRefs ?? [],
  };
}

function report(
  overrides: {
    rows?: number;
    baselineRows?: number | null;
    passed?: boolean;
    breaches?: string[];
    fields?: FieldReport[];
    contractVersion?: string;
  } = {}
): ContractReport {
  return {
    sourceId: "arcadia",
    contractVersion: overrides.contractVersion ?? "arcadia@1",
    at: "2026-08-17T12:00:00.000Z",
    rows: overrides.rows ?? 12,
    baselineRows: overrides.baselineRows === undefined ? 12 : overrides.baselineRows,
    rowDropRate: 0,
    passed: overrides.passed ?? false,
    breaches: overrides.breaches ?? [],
    fields: overrides.fields ?? [field({ field: "hazard", nullRate: 1, breached: true })],
  };
}

function diagnosis(
  overrides: {
    cause?: Diagnosis["cause"];
    withdrawnRefs?: string[];
    lostRefs?: string[];
    unresolvedRefs?: string[];
    healable?: boolean;
    evidence?: string[];
  } = {}
): Diagnosis {
  const cause = overrides.cause ?? "drift";
  return {
    cause,
    withdrawnRefs: overrides.withdrawnRefs ?? [],
    lostRefs: overrides.lostRefs ?? [],
    unresolvedRefs: overrides.unresolvedRefs ?? [],
    healable: overrides.healable ?? (cause === "drift" || cause === "pagination"),
    evidence: overrides.evidence ?? ["field hazard null rate 100.0%"],
  };
}

function markup(
  overrides: {
    listingStatus?: number;
    listingBytes?: number;
    deadSelectors?: string[];
    observedHooks?: string[];
    observedLabels?: string[];
  } = {}
): MarkupObservation {
  return {
    listingStatus: overrides.listingStatus ?? 200,
    listingBytes: overrides.listingBytes ?? 8192,
    deadSelectors: overrides.deadSelectors ?? [".notice h2"],
    observedHooks: overrides.observedHooks ?? ["data-ref"],
    observedLabels: overrides.observedLabels ?? ["Title"],
  };
}

function args(
  overrides: {
    diagnosis?: Diagnosis;
    report?: ContractReport;
    markup?: MarkupObservation;
    targetUrl?: string;
    extraPaths?: readonly string[];
    maxChars?: number;
  } = {}
): SynthesiseArgs {
  const value: SynthesiseArgs = {
    diagnosis: overrides.diagnosis ?? diagnosis(),
    report: overrides.report ?? report(),
    markup: overrides.markup ?? markup(),
    targetUrl: overrides.targetUrl ?? "https://arcadia.test/recalls",
  };
  if (overrides.extraPaths !== undefined) {
    value.extraPaths = overrides.extraPaths;
  }
  if (overrides.maxChars !== undefined) {
    value.maxChars = overrides.maxChars;
  }
  return value;
}

function assertThrowsNotHealable(cause: Diagnosis["cause"], whyFragment?: string) {
  assert.throws(
    () =>
      synthesiseHealPrompt(
        args({
          diagnosis: diagnosis({
            cause,
            healable: false,
            withdrawnRefs: cause === "gone" ? ["ARC-0001"] : [],
          }),
        })
      ),
    (err: unknown) => {
      assert.ok(err instanceof NotHealableError, `expected NotHealableError, got ${String(err)}`);
      assert.equal(err.cause_, cause);
      if (whyFragment !== undefined) {
        assert.ok(err.why.includes(whyFragment), `why should mention ${whyFragment}: ${err.why}`);
      }
      return true;
    }
  );
}

describe("synthesiseHealPrompt", () => {
  it("throws NotHealableError for a withdrawn notice", () => {
    assertThrowsNotHealable("gone", "phantom");
  });

  it("throws NotHealableError for a blocked source", () => {
    assertThrowsNotHealable("blocked", "block");
  });

  it("throws NotHealableError when nothing is broken", () => {
    assertThrowsNotHealable("healthy", "nothing is broken");
  });

  it("returns a usable prompt for healable drift", () => {
    const prompt = synthesiseHealPrompt(args());
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.length > 0);
    assert.ok(prompt.length <= 1000);
    assert.ok(prompt.includes("Re-extract every notice from https://arcadia.test/recalls"));
  });

  it("names the specific breached fields rather than something generic", () => {
    const prompt = synthesiseHealPrompt(
      args({
        report: report({
          rows: 12,
          fields: [
            field({ field: "hazard", nullRate: 1, breached: true, sampleRefs: ["ARC-0001"] }),
            field({
              field: "published",
              nullRate: 0,
              typeErrors: 12,
              breached: true,
              sampleRefs: ["ARC-0002"],
            }),
            field({ field: "title", nullRate: 0, breached: false }),
          ],
        }),
      })
    );
    assert.ok(prompt.includes("hazard"), prompt);
    assert.ok(prompt.includes("published"), prompt);
    assert.ok(!prompt.includes("title ("), prompt);
  });

  it("strips angle brackets that the live API rejects", () => {
    const prompt = synthesiseHealPrompt(
      args({
        markup: markup({
          deadSelectors: ["div.notice > h2", "<article class='card'>"],
          observedHooks: ['data-title="<brand>"'],
          observedLabels: ["<Hazard>", "Action"],
        }),
        targetUrl: "https://arcadia.test/recalls?q=<all>",
      })
    );
    assert.equal(prompt.includes("<"), false, prompt);
    assert.equal(prompt.includes(">"), false, prompt);
  });

  it("never exceeds 1000 characters even with many breached fields and long evidence", () => {
    const fields = Array.from({ length: 20 }, (_, i) =>
      field({
        field: `field_${i}_with_a_deliberately_long_name`,
        nullRate: 1,
        breached: true,
        sampleRefs: ["ARC-0001", "ARC-0002", "ARC-0003"],
      })
    );
    const prompt = synthesiseHealPrompt(
      args({
        report: report({ rows: 12, fields }),
        markup: markup({
          deadSelectors: ["div.notice-card > article > header > h2.product-title"],
          observedHooks: Array.from({ length: 40 }, (_, i) => `data-hook-${i}-${"x".repeat(30)}`),
          observedLabels: Array.from({ length: 40 }, (_, i) => `Label ${i} ${"y".repeat(30)}`),
        }),
        diagnosis: diagnosis({
          evidence: Array.from({ length: 20 }, (_, i) => `evidence line ${i} ${"z".repeat(80)}`),
        }),
      })
    );
    assert.ok(prompt.length <= 1000, `prompt was ${prompt.length} chars`);
  });

  it("keeps the instruction clause after truncation", () => {
    const targetUrl = "https://arcadia.test/recalls";
    const uniqueHook = `UNIQUE_HOOK_MARKER_${"w".repeat(900)}`;
    const prompt = synthesiseHealPrompt(
      args({
        targetUrl,
        markup: markup({
          deadSelectors: [`.old-selector-${"a".repeat(200)}`],
          observedHooks: [uniqueHook],
          observedLabels: [`UNIQUE_LABEL_MARKER_${"b".repeat(400)}`],
        }),
      })
    );
    assert.ok(prompt.length <= 1000, `prompt was ${prompt.length} chars`);
    assert.ok(
      prompt.includes(`Re-extract every notice from ${targetUrl}`),
      `instruction was dropped: ${prompt}`
    );
    assert.equal(prompt.includes(uniqueHook), false, "expected the oversized hook clause to be dropped");
  });
});

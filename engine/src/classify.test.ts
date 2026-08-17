import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  type ClassifyInput,
  type Diagnosis,
  type ListingProbe,
  type PermalinkProbe,
} from "./classify.js";
import type { ContractReport, FieldReport } from "./contract.js";
import { NotHealableError, synthesiseHealPrompt, type MarkupObservation } from "./prompt.js";

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
    rowDropRate?: number | null;
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
    rowDropRate: overrides.rowDropRate === undefined ? 0 : overrides.rowDropRate,
    passed: overrides.passed ?? true,
    breaches: overrides.breaches ?? [],
    fields: overrides.fields ?? [field()],
  };
}

function listing(
  overrides: { status?: number; bodyBytes?: number; blockSignature?: string | null } = {}
): ListingProbe {
  return {
    status: overrides.status ?? 200,
    bodyBytes: overrides.bodyBytes ?? 8192,
    blockSignature: overrides.blockSignature === undefined ? null : overrides.blockSignature,
  };
}

function refs(n: number, start = 1): string[] {
  return Array.from({ length: n }, (_, i) => `ARC-${String(start + i).padStart(4, "0")}`);
}

function input(
  overrides: {
    report?: ContractReport;
    listing?: ListingProbe;
    baselineRefs?: readonly string[];
    currentRefs?: readonly string[];
    permalinks?: readonly PermalinkProbe[];
    rowsPerPage?: number;
  } = {}
): ClassifyInput {
  const value: ClassifyInput = {
    report: overrides.report ?? report(),
    listing: overrides.listing ?? listing(),
    baselineRefs: overrides.baselineRefs ?? refs(12),
    currentRefs: overrides.currentRefs ?? refs(12),
    permalinks: overrides.permalinks ?? [],
  };
  if (overrides.rowsPerPage !== undefined) {
    value.rowsPerPage = overrides.rowsPerPage;
  }
  return value;
}

function markup(): MarkupObservation {
  return {
    listingStatus: 200,
    listingBytes: 8192,
    deadSelectors: [".notice-card h2"],
    observedHooks: ["data-ref", "data-hazard"],
    observedLabels: ["Title", "Hazard"],
  };
}

function promptArgs(diagnosis: Diagnosis, contractReport: ContractReport) {
  return {
    diagnosis,
    report: contractReport,
    markup: markup(),
    targetUrl: "https://arcadia.test/recalls",
  };
}

function assertNotHealable(diagnosis: Diagnosis, contractReport: ContractReport, cause: string) {
  assert.throws(
    () => synthesiseHealPrompt(promptArgs(diagnosis, contractReport)),
    (err: unknown) => {
      assert.ok(err instanceof NotHealableError, `expected NotHealableError, got ${String(err)}`);
      assert.equal(err.cause_, cause);
      return true;
    }
  );
}

describe("classify", () => {
  it("records withdrawn refs when every missing permalink 404s", () => {
    const baselineRefs = refs(3);
    const diagnosis = classify(
      input({
        report: report({
          rows: 0,
          baselineRows: 3,
          rowDropRate: 1,
          passed: false,
          breaches: [
            "field title null rate 100.0% exceeds limit 0.0% over 0 rows",
            "returned 0 rows, contract requires at least 1",
          ],
          fields: [field({ nullRate: 1, breached: true })],
        }),
        listing: listing({ status: 200 }),
        baselineRefs,
        currentRefs: [],
        permalinks: baselineRefs.map((ref) => ({ ref, status: 404 })),
      })
    );
    assert.deepEqual(diagnosis.withdrawnRefs, baselineRefs);
    assert.deepEqual(diagnosis.lostRefs, []);
  });

  // The single most important test in the project. Every notice was withdrawn, so
  // extraction legitimately returns nothing. A healer that reads an empty result as
  // breakage will find some node to fill the gap and republish a phantom safety
  // recall. Both the classifier and the prompt synthesiser have to refuse.
  it("refuses to heal a withdrawn notice", () => {
      const baselineRefs = refs(3);
      const contractReport = report({
        rows: 0,
        baselineRows: 3,
        rowDropRate: 1,
        passed: false,
        breaches: [
          "field title null rate 100.0% exceeds limit 0.0% over 0 rows",
          "returned 0 rows, contract requires at least 1",
          "row count fell from 3 to 0, a 100.0% drop, limit 20.0%",
        ],
        fields: [field({ nullRate: 1, breached: true })],
      });
      const diagnosis = classify(
        input({
          report: contractReport,
          listing: listing({ status: 200 }),
          baselineRefs,
          currentRefs: [],
          permalinks: baselineRefs.map((ref) => ({ ref, status: 404 })),
        })
      );

      assert.equal(diagnosis.cause, "gone");
      assert.equal(diagnosis.healable, false);
      assert.deepEqual(diagnosis.withdrawnRefs, baselineRefs);
      assert.deepEqual(diagnosis.lostRefs, []);
      assertNotHealable(diagnosis, contractReport, "gone");
  });

  // 410 is the explicit "deliberately removed" status, so it must be treated exactly
  // as strictly as 404 rather than being the case nobody remembered to handle.
  it("treats a 410 permalink as withdrawn, not lost", () => {
      const baselineRefs = refs(2);
      const contractReport = report({
        rows: 0,
        baselineRows: 2,
        rowDropRate: 1,
        passed: false,
        breaches: [
          "field title null rate 100.0% exceeds limit 0.0% over 0 rows",
          "returned 0 rows, contract requires at least 1",
        ],
        fields: [field({ nullRate: 1, breached: true })],
      });
      const diagnosis = classify(
        input({
          report: contractReport,
          baselineRefs,
          currentRefs: [],
          permalinks: baselineRefs.map((ref) => ({ ref, status: 410 })),
        })
      );

      assert.equal(diagnosis.cause, "gone");
      assert.equal(diagnosis.healable, false);
      assert.deepEqual(diagnosis.withdrawnRefs, baselineRefs);
      assertNotHealable(diagnosis, contractReport, "gone");
  });

  it("refuses to heal a 403 listing", () => {
    const contractReport = report({ passed: false, rows: 0, breaches: ["returned 0 rows"] });
    const diagnosis = classify(
      input({
        report: contractReport,
        listing: listing({ status: 403, bodyBytes: 200 }),
        baselineRefs: refs(3),
        currentRefs: [],
        permalinks: [],
      })
    );

    assert.equal(diagnosis.cause, "blocked");
    assert.equal(diagnosis.healable, false);
    assert.deepEqual(diagnosis.withdrawnRefs, []);
    assert.deepEqual(diagnosis.lostRefs, []);
    assertNotHealable(diagnosis, contractReport, "blocked");
  });

  it("refuses to heal a 200 listing that carries a block signature", () => {
    // The dangerous real case: a bot wall that does not announce itself with a 4xx.
    const contractReport = report({
      passed: false,
      rows: 0,
      breaches: ["returned 0 rows, contract requires at least 1"],
    });
    const diagnosis = classify(
      input({
        report: contractReport,
        listing: listing({ status: 200, bodyBytes: 1400, blockSignature: "cf-challenge" }),
        baselineRefs: refs(3),
        currentRefs: [],
        permalinks: refs(3).map((ref) => ({ ref, status: 200 })),
      })
    );

    assert.equal(diagnosis.cause, "blocked");
    assert.equal(diagnosis.healable, false);
    assertNotHealable(diagnosis, contractReport, "blocked");
  });

  it("classifies field-level layout change as healable drift", () => {
    const missing = ["ARC-0011", "ARC-0012"];
    const contractReport = report({
      rows: 10,
      baselineRows: 12,
      rowDropRate: 2 / 12,
      passed: false,
      breaches: ["field hazard null rate 100.0% exceeds limit 0.0% over 10 rows"],
      fields: [
        field({ field: "hazard", nullRate: 1, nullRateLimit: 0, breached: true, sampleRefs: ["ARC-0001"] }),
      ],
    });
    const diagnosis = classify(
      input({
        report: contractReport,
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(10),
        permalinks: missing.map((ref) => ({ ref, status: 200 })),
      })
    );

    assert.equal(diagnosis.cause, "drift");
    assert.equal(diagnosis.healable, true);
    assert.deepEqual(diagnosis.lostRefs, missing);
    const prompt = synthesiseHealPrompt(promptArgs(diagnosis, contractReport));
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes("hazard"));
    assert.ok(prompt.includes("Re-extract every notice from https://arcadia.test/recalls"));
  });

  it("classifies an empty extraction whose permalinks still resolve as healable drift", () => {
    const baselineRefs = refs(3);
    const contractReport = report({
      rows: 0,
      baselineRows: 3,
      rowDropRate: 1,
      passed: false,
      breaches: [
        "field title null rate 100.0% exceeds limit 0.0% over 0 rows",
        "returned 0 rows, contract requires at least 1",
      ],
      fields: [field({ nullRate: 1, breached: true })],
    });
    const diagnosis = classify(
      input({
        report: contractReport,
        listing: listing({ status: 200, bodyBytes: 6400 }),
        baselineRefs,
        currentRefs: [],
        permalinks: baselineRefs.map((ref) => ({ ref, status: 200 })),
      })
    );

    assert.equal(diagnosis.cause, "drift");
    assert.equal(diagnosis.healable, true);
    assert.deepEqual(diagnosis.lostRefs, baselineRefs);
    assert.deepEqual(diagnosis.withdrawnRefs, []);
    const prompt = synthesiseHealPrompt(promptArgs(diagnosis, contractReport));
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes("Re-extract"));
  });

  it("reports explained withdrawals as gone, never drift", () => {
    // Every missing record 404s and the remaining rows satisfy the contract.
    // A naive healer sees the row count fall, calls it a cliff, and invents
    // replacements. That is the failure this project exists to prevent.
    //
    // The cause is "gone" rather than "healthy" on purpose: a withdrawal is an
    // event the feed has to surface, and the refusal to heal should be visible in
    // the incident record rather than implied by the absence of one.
    const withdrawn = ["ARC-0011", "ARC-0012"];
    const contractReport = report({
      rows: 10,
      baselineRows: 12,
      rowDropRate: 2 / 12,
      passed: true,
      breaches: [],
      fields: [field({ breached: false })],
    });
    const diagnosis = classify(
      input({
        report: contractReport,
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(10),
        permalinks: withdrawn.map((ref) => ({ ref, status: 404 })),
      })
    );

    assert.equal(diagnosis.cause, "gone");
    assert.notEqual(diagnosis.cause, "drift");
    assert.equal(diagnosis.healable, false);
    assert.deepEqual(diagnosis.withdrawnRefs, withdrawn);
    assert.deepEqual(diagnosis.lostRefs, []);
    assertNotHealable(diagnosis, contractReport, "gone");
  });

  it("does not treat a row-count cliff caused only by withdrawals as drift", () => {
    const withdrawn = refs(4, 9); // ARC-0009 .. ARC-0012
    const contractReport = report({
      rows: 8,
      baselineRows: 12,
      rowDropRate: 4 / 12,
      passed: false,
      breaches: [
        "returned 8 rows, contract requires at least 10",
        "row count fell from 12 to 8, a 33.3% drop, limit 20.0%",
      ],
      fields: [field({ breached: false })],
    });
    const diagnosis = classify(
      input({
        report: contractReport,
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(8),
        permalinks: withdrawn.map((ref) => ({ ref, status: 404 })),
      })
    );

    assert.equal(diagnosis.cause, "gone");
    assert.notEqual(diagnosis.cause, "drift");
    assert.equal(diagnosis.healable, false);
    assert.deepEqual(diagnosis.withdrawnRefs, withdrawn);
    assertNotHealable(diagnosis, contractReport, "gone");
  });
});

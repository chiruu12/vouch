import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  type ClassifyInput,
  type Diagnosis,
  type ListingProbe,
  type PermalinkProbe,
  blockedAtSource,
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

// The oracle's own failure modes.
//
// Both of these were found by an adversarial review panel, independently, and both
// defeated the guarantee this file exists to enforce. Block detection was body-aware
// from the start while withdrawal detection was status-only, which put the weaker
// detector on the case the project is actually about.
describe("the withdrawal oracle when it is not a clean 404", () => {
  it("treats a 200 whose body says the record is gone as a withdrawal, not a loss", () => {
    // Plenty of sites answer 200 with a "no longer available" page. Status-only
    // detection filed such a ref under `lost`, which routes to drift, which heals:
    // a record deliberately taken down, replaced with invented data, no incident.
    const missing = ["ARC-0011", "ARC-0012"];
    const contractReport = report({
      rows: 10,
      baselineRows: 12,
      rowDropRate: 2 / 12,
      passed: false,
      breaches: ["row count fell from 12 to 10"],
    });
    const diagnosis = classify(
      input({
        report: contractReport,
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(10),
        permalinks: missing.map((ref) => ({
          ref,
          status: 200,
          goneSignature: "this listing is no longer available",
        })),
      })
    );

    assert.equal(diagnosis.cause, "gone");
    assert.equal(diagnosis.healable, false, "a soft 404 must never be healed");
    assert.deepEqual(diagnosis.withdrawnRefs, missing);
    assert.deepEqual(diagnosis.lostRefs, []);
    assertNotHealable(diagnosis, contractReport, "gone");
  });

  it("refuses to repair when the oracle did not answer at all", () => {
    // A transport failure is not evidence of presence. Repairing asserts the missing
    // records are still published, and that is precisely what we failed to establish.
    const missing = ["ARC-0011", "ARC-0012"];
    const contractReport = report({
      rows: 10,
      baselineRows: 12,
      rowDropRate: 2 / 12,
      passed: false,
      breaches: ["row count fell from 12 to 10"],
    });
    const diagnosis = classify(
      input({
        report: contractReport,
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(10),
        permalinks: missing.map((ref) => ({ ref, status: 0 })),
      })
    );

    assert.equal(diagnosis.healable, false, "an unreachable oracle must not authorise a repair");
    assert.deepEqual(diagnosis.unresolvedRefs, missing);
    assert.deepEqual(diagnosis.withdrawnRefs, []);
    assert.deepEqual(diagnosis.lostRefs, []);
  });

  it("refuses to repair when the oracle returns 5xx", () => {
    const missing = ["ARC-0012"];
    const diagnosis = classify(
      input({
        report: report({ rows: 11, baselineRows: 12, rowDropRate: 1 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(11),
        permalinks: missing.map((ref) => ({ ref, status: 503 })),
      })
    );

    assert.equal(diagnosis.healable, false);
    assert.deepEqual(diagnosis.unresolvedRefs, missing);
  });

  it("refuses to repair when one ref of several could not be checked", () => {
    // The mixed case is the one that matters: two refs clearly still live, one
    // unreachable. A repair would be justified by the two and would fabricate the third.
    const diagnosis = classify(
      input({
        report: report({ rows: 9, baselineRows: 12, rowDropRate: 3 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(9),
        permalinks: [
          { ref: "ARC-0010", status: 200 },
          { ref: "ARC-0011", status: 200 },
          { ref: "ARC-0012", status: 0 },
        ],
      })
    );

    assert.equal(diagnosis.healable, false, "one unreachable ref is enough to stop a repair");
    assert.deepEqual(diagnosis.unresolvedRefs, ["ARC-0012"]);
  });

  it("still heals when every missing ref is confirmed live", () => {
    // The guard must not fire on the healthy repairable case, or it would refuse
    // everything and the refusal would stop meaning anything.
    const missing = ["ARC-0011", "ARC-0012"];
    const diagnosis = classify(
      input({
        report: report({
          rows: 10,
          baselineRows: 12,
          rowDropRate: 2 / 12,
          passed: false,
          breaches: ["field hazard null rate 100.0% exceeds limit 0.0% over 10 rows"],
          fields: [field({ field: "hazard", nullRate: 1, breached: true })],
        }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(10),
        permalinks: missing.map((ref) => ({ ref, status: 200 })),
      })
    );

    assert.equal(diagnosis.healable, true);
    assert.deepEqual(diagnosis.unresolvedRefs, []);
  });
});

describe("oracle statuses that are neither alive nor withdrawn", () => {
  for (const status of [403, 429, 408]) {
    it(`refuses to repair when a permalink answers ${status}`, () => {
      // Being rate limited or walled off from a record's page is not evidence the
      // record is still published. Filing it as merely lost is what hands the case
      // to a repair, which is the whole failure this file prevents.
      const diagnosis = classify(
        input({
          report: report({ rows: 10, baselineRows: 12, rowDropRate: 2 / 12, passed: false }),
          listing: listing({ status: 200 }),
          baselineRefs: refs(12),
          currentRefs: refs(10),
          permalinks: ["ARC-0011", "ARC-0012"].map((ref) => ({ ref, status })),
        })
      );
      assert.equal(diagnosis.healable, false, `${status} must not authorise a repair`);
      assert.deepEqual(diagnosis.unresolvedRefs, ["ARC-0011", "ARC-0012"]);
    });
  }

  it("refuses to repair on a status nobody thought of", () => {
    // 418 is not a real case. It stands in for every status this list does not name.
    // The guard started as a blocklist of statuses we had been bitten by, and a
    // property test produced this within seconds: an unrecognised status fell through
    // to `lost`, which is the verdict that authorises a repair. The guard is now an
    // allowlist, so the next unfamiliar response is refused rather than trusted.
    const diagnosis = classify(
      input({
        report: report({ rows: 10, baselineRows: 12, rowDropRate: 2 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(10),
        permalinks: ["ARC-0011", "ARC-0012"].map((ref) => ({ ref, status: 418 })),
      })
    );
    assert.equal(diagnosis.healable, false);
    assert.deepEqual(diagnosis.unresolvedRefs, ["ARC-0011", "ARC-0012"]);
  });

  it("names the signal that established each withdrawal", () => {
    // The evidence line used to claim "404 or 410" whatever the probe actually saw.
    const diagnosis = classify(
      input({
        report: report({ rows: 10, baselineRows: 12, rowDropRate: 2 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(10),
        permalinks: [
          { ref: "ARC-0011", status: 404 },
          { ref: "ARC-0012", status: 200, goneSignature: "permalink redirected to /category" },
        ],
      })
    );
    const line = diagnosis.evidence.find((e) => e.includes("no longer serve the record")) ?? "";
    assert.match(line, /HTTP 404/);
    assert.match(line, /redirected to \/category/);
  });

  it("classifies a clean pagination break as repairable", () => {
    // Asserted explicitly because every other test here is about refusing. If the
    // repairable path silently stopped working, the refusals would stop meaning anything.
    const diagnosis = classify(
      input({
        report: report({ rows: 7, baselineRows: 14, rowDropRate: 0.5, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(14),
        currentRefs: refs(7),
        permalinks: refs(14).slice(7).map((ref) => ({ ref, status: 200 })),
        rowsPerPage: 7,
      })
    );
    assert.equal(diagnosis.cause, "pagination");
    assert.equal(diagnosis.healable, true);
  });
});

describe("contradictory probes for the same record", () => {
  it("takes the withdrawal, not the last reading", () => {
    // Building the lookup with `new Map(pairs)` kept the last entry, so a ref probed
    // 404 and then 200 resolved to 200, became lost, and authorised a repair on a
    // record that had already told us it was gone.
    const diagnosis = classify(
      input({
        report: report({ rows: 11, baselineRows: 12, rowDropRate: 1 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(11),
        permalinks: [
          { ref: "ARC-0012", status: 404 },
          { ref: "ARC-0012", status: 200 },
        ],
      })
    );
    assert.deepEqual(diagnosis.withdrawnRefs, ["ARC-0012"]);
    assert.equal(diagnosis.healable, false);
  });

  it("takes the withdrawal whichever order it arrives in", () => {
    const diagnosis = classify(
      input({
        report: report({ rows: 11, baselineRows: 12, rowDropRate: 1 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(11),
        permalinks: [
          { ref: "ARC-0012", status: 200 },
          { ref: "ARC-0012", status: 404 },
        ],
      })
    );
    assert.deepEqual(diagnosis.withdrawnRefs, ["ARC-0012"]);
  });

  it("prefers an unresolved reading over a clean 200", () => {
    // Two contradictory readings where neither says gone: one says the record is fine
    // and one says nothing at all. Nothing at all is the answer that refuses.
    const diagnosis = classify(
      input({
        report: report({ rows: 11, baselineRows: 12, rowDropRate: 1 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(11),
        permalinks: [
          { ref: "ARC-0012", status: 200 },
          { ref: "ARC-0012", status: 0 },
        ],
      })
    );
    assert.deepEqual(diagnosis.unresolvedRefs, ["ARC-0012"]);
    assert.equal(diagnosis.healable, false);
  });
});

describe("a withdrawal alongside an unreachable probe", () => {
  // Every test added for the unresolved guard checked `healable === false` and none
  // checked the cause or the evidence, so an ordering bug hid behind them: the guard
  // returned before the withdrawal was written into the evidence, and the incident log
  // showed drift with no mention that a record had been taken down. The state carried
  // the withdrawal, which makes it worse rather than better: the feed knew and did not
  // say. These assert what the log actually contains.
  const mixed = (): Diagnosis =>
    classify(
      input({
        report: report({ rows: 10, baselineRows: 12, rowDropRate: 2 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(10),
        permalinks: [
          { ref: "ARC-0011", status: 404 },
          { ref: "ARC-0012", status: 0 },
        ],
      })
    );

  it("records the withdrawal as well as the failure to check", () => {
    const d = mixed();
    assert.deepEqual(d.withdrawnRefs, ["ARC-0011"]);
    assert.deepEqual(d.unresolvedRefs, ["ARC-0012"]);
    assert.ok(
      d.evidence.some((e) => e.includes("no longer serve the record") && e.includes("ARC-0011")),
      "the withdrawal must be in the evidence, not only in the state"
    );
    assert.ok(
      d.evidence.some((e) => e.includes("could not be checked") && e.includes("ARC-0012")),
      "and so must the record we could not check"
    );
  });

  it("refuses the repair and says so as drift, not as gone", () => {
    const d = mixed();
    assert.equal(d.healable, false);
    // `gone` means every loss is explained by a withdrawal, and here one is not.
    assert.equal(d.cause, "drift");
  });

  it("names the status it actually saw rather than guessing at the reason", () => {
    // The first wording said "transport failure, timeout or 5xx" for every unresolved
    // ref, including a 403, which put a cause in the log that the probe never observed.
    const d = classify(
      input({
        report: report({ rows: 11, baselineRows: 12, rowDropRate: 1 / 12, passed: false }),
        listing: listing({ status: 200 }),
        baselineRefs: refs(12),
        currentRefs: refs(11),
        permalinks: [{ ref: "ARC-0012", status: 403 }],
      })
    );
    const line = d.evidence.find((e) => e.includes("could not be checked")) ?? "";
    assert.match(line, /HTTP 403/);
    assert.doesNotMatch(line, /transport failure/);
  });
});

// A wall the collector hits and our probe does not.
//
// The listing probe goes out from wherever the supervisor runs; the collector goes out
// from Bright Data's network. Sites treat those differently, and the case that matters
// is the one where the collector is refused and we are not: zero rows, a clean 200 from
// our side, previously diagnosed as drift and sent to the healer. The flagship refusal
// depended on the block being visible from the operator's network, which is the one
// place it does not need to be visible.
describe("a block on the scraper's path only", () => {
  const cleanProbe = { status: 200, bodyBytes: 40000, blockSignature: null, body: "<html></html>" };

  it("recognises a refusal the collector reported, on a page that answered us fine", () => {
    const d = classify({
      report: report({ rows: 0, passed: false, breaches: ["row count fell to 0"] }),
      listing: cleanProbe,
      baselineRefs: ["r1", "r2", "r3"],
      currentRefs: [],
      permalinks: [],
      extractionErrors: [{ error: "Request failed", error_code: "http_403" }],
    });
    assert.equal(d.cause, "blocked");
    assert.equal(d.healable, false);
    assert.match(d.evidence.join(" "), /wall is on the scraper's path/);
  });

  it("names both when our probe was refused too", () => {
    const d = classify({
      report: report({ rows: 0, passed: false, breaches: ["row count fell to 0"] }),
      listing: { ...cleanProbe, status: 403 },
      baselineRefs: ["r1", "r2", "r3"],
      currentRefs: [],
      permalinks: [],
      extractionErrors: [{ error: "blocked by target", error_code: "blocked" }],
    });
    assert.equal(d.cause, "blocked");
    assert.match(d.evidence.join(" "), /collector reported/);
  });

  it("reads a rate limit and a captcha challenge as refusals", () => {
    for (const e of [
      { error: "Too Many Requests", error_code: "http_429" },
      { error: "captcha challenge presented", error_code: "extraction_failed" },
      { error: "Access denied", error_code: "http_403" },
    ]) {
      assert.equal(blockedAtSource([e]) !== null, true, `${e.error_code} should read as a block`);
    }
  });

  it("does not read an ordinary extraction failure as a block", () => {
    // The distinction the whole branch rests on. A dead page or a selector that stopped
    // matching is repairable; being refused is not. Reading the first as the second
    // would refuse every repair this system exists to make.
    for (const e of [
      { error: "page returned no items", error_code: "dead_page" },
      { error: "selector matched 0 elements", error_code: "extraction_failed" },
      { error: "timeout while loading", error_code: "timeout" },
    ]) {
      assert.equal(blockedAtSource([e]), null, `${e.error_code} must stay repairable`);
    }
  });

  it("reads every status the probe side calls a refusal", () => {
    // These two lists used to be written out separately and they disagreed. The probe
    // treated 401, 451 and 503 as refusals; the error pattern knew only 403, 407 and 429.
    // The same wall was therefore refused when our probe hit it and healed when only the
    // collector did, which is the exact inconsistency this branch exists to remove.
    for (const code of ["http_401", "http_403", "http_407", "http_429", "http_451", "http_503"]) {
      assert.equal(blockedAtSource([{ error: "refused", error_code: code }]) !== null, true, code);
    }
    // No separator at all, which flattening never helped with.
    assert.equal(blockedAtSource([{ error: "http403 from target" }]) !== null, true, "http403");
  });

  it("does not find a block status inside a longer number", () => {
    // 4030 is not 403. Without the digit guards this reads a page size or an item id as a
    // refusal and permanently refuses to repair the source.
    assert.equal(blockedAtSource([{ error: "returned 4030 items", error_code: "ok" }]), null);
    assert.equal(blockedAtSource([{ error: "id 14510 missing", error_code: "extraction_failed" }]), null);
  });

  it("keeps a withdrawal that was established before the wall went up", () => {
    // A block means we cannot trust what we failed to read. It says nothing about a
    // permalink that answered us plainly with a 404, and dropping that record left it in
    // the baseline, still served from last-good as an active recall, until the wall came
    // down and it could be rediscovered.
    const d = classify({
      report: report({ rows: 0, passed: false, breaches: ["row count fell to 0"] }),
      listing: cleanProbe,
      baselineRefs: ["r1", "r2", "r3"],
      currentRefs: [],
      permalinks: [{ ref: "r1", status: 404 }, { ref: "r2", status: 200 }, { ref: "r3", status: 200 }],
      extractionErrors: [{ error: "Too Many Requests", error_code: "http_429" }],
    });
    assert.equal(d.cause, "blocked");
    assert.equal(d.healable, false);
    assert.deepEqual(d.withdrawnRefs, ["r1"]);
    // Still nothing is repairable. "Missing while its own page is fine" is precisely the
    // inference a block invalidates, so lostRefs stays empty.
    assert.deepEqual(d.lostRefs, []);
  });

  it("still diagnoses drift when the collector reported nothing", () => {
    const d = classify({
      report: report({ rows: 0, passed: false, breaches: ["row count fell to 0"] }),
      listing: cleanProbe,
      baselineRefs: ["r1", "r2", "r3"],
      currentRefs: [],
      permalinks: [{ ref: "r1", status: 200 }, { ref: "r2", status: 200 }, { ref: "r3", status: 200 }],
      extractionErrors: [],
    });
    assert.equal(d.cause, "drift");
    assert.equal(d.healable, true);
  });
});

// --- infrastructure failures are not page changes --------------------------

it("a listing serving 5xx is a wall, not a redesign", () => {
  // The ordinary infrastructure split: a dynamic listing API is down while the static
  // notice pages carry on serving. BLOCK_STATUSES knew 503 and not its neighbours, so
  // this classified as healable drift and authorised a repair against a server that
  // was not answering. Nothing about the markup changed, so there is nothing to repair.
  // The permalinks answering 200 is the whole point of the fixture. Without it the
  // missing refs are unresolved, the classifier refuses on those grounds, and the test
  // passes without the status ever being consulted. That is how this defect survived:
  // every case that reached it was already being refused for an unrelated reason.
  const live = refs(12).map((ref) => ({ ref, status: 200 }));

  for (const status of [500, 502, 503, 504, 408]) {
    const d = classify(
      input({
        report: report({ rows: 0, passed: false, breaches: ["returned 0 rows"] }),
        listing: listing({ status }),
        currentRefs: [],
        permalinks: live,
      })
    );

    assert.equal(d.cause, "blocked", `HTTP ${status} should read as blocked`);
    assert.equal(d.healable, false, `HTTP ${status} must not authorise a repair`);
  }
});

it("a listing probe that never answered is not evidence the page changed", () => {
  // Status 0 is our own probe timing out or failing to connect. It matched nothing, so
  // it fell through to drift and sent a healer at a source we could not even reach.
  // Unknown is not a diagnosis, and it is certainly not one that authorises a repair.
  const d = classify(
    input({
      report: report({ rows: 0, passed: false, breaches: ["returned 0 rows"] }),
      listing: listing({ status: 0 }),
      currentRefs: [],
      permalinks: refs(12).map((ref) => ({ ref, status: 200 })),
    })
  );

  assert.equal(d.healable, false, "a probe that did not answer cannot authorise a repair");
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkContract, type FieldRule, type SourceContract } from "./contract.js";
import type { RecallRecord, RiskLevel } from "./types.js";

type Candidate = Omit<RecallRecord, "provenance">;

function candidate(
  overrides: {
    ref?: string;
    permalink?: string | null;
    title?: string;
    brand?: string | null;
    hazard?: string | null;
    risk?: RiskLevel;
    category?: string | null;
    affectedUnits?: string | null;
    published?: string | null;
    action?: string | null;
  } = {}
): Candidate {
  const ref = overrides.ref ?? "ARC-0001";
  return {
    ref,
    permalink:
      overrides.permalink === undefined ? `https://arcadia.test/n/${ref}` : overrides.permalink,
    title: overrides.title ?? "Recall of ceramic kettles after overheating",
    brand: overrides.brand === undefined ? "Acme Home" : overrides.brand,
    hazard:
      overrides.hazard === undefined
        ? "Risk of electric shock from damaged insulation"
        : overrides.hazard,
    risk: overrides.risk ?? "High",
    category: overrides.category === undefined ? "Kitchen" : overrides.category,
    affectedUnits:
      overrides.affectedUnits === undefined ? "Lots A1 to A9" : overrides.affectedUnits,
    published: overrides.published === undefined ? "2026-08-08" : overrides.published,
    action:
      overrides.action === undefined ? "Stop using the product and return it" : overrides.action,
  };
}

function rows(n: number, tweak?: (row: Candidate, i: number) => Candidate): Candidate[] {
  return Array.from({ length: n }, (_, i) => {
    const row = candidate({ ref: `ARC-${String(i + 1).padStart(4, "0")}` });
    return tweak ? tweak(row, i) : row;
  });
}

function contract(
  overrides: {
    minRows?: number;
    maxRowDropRate?: number;
    fields?: Record<string, FieldRule>;
  } = {}
): SourceContract {
  return {
    version: "test@1",
    sourceId: "arcadia",
    minRows: overrides.minRows ?? 1,
    maxRowDropRate: overrides.maxRowDropRate ?? 0.5,
    fields: overrides.fields ?? {
      brand: { type: "string", maxNullRate: 0.2, minLength: 2 },
    },
  };
}

const frozenNow = () => new Date("2026-08-17T12:00:00.000Z");

function fieldNamed(report: ReturnType<typeof checkContract>, name: string) {
  const field = report.fields.find((f) => f.field === name);
  assert.ok(field, `expected a field report for ${name}`);
  return field;
}

describe("checkContract", () => {
  it("passes a clean run with no breaches", () => {
    const report = checkContract(contract({ minRows: 3 }), rows(5), 5, frozenNow);
    assert.equal(report.passed, true);
    assert.deepEqual(report.breaches, []);
    assert.equal(report.rows, 5);
    assert.equal(report.baselineRows, 5);
    assert.equal(report.rowDropRate, 0);
    assert.equal(report.at, "2026-08-17T12:00:00.000Z");
    for (const field of report.fields) {
      assert.equal(field.breached, false);
      assert.equal(field.nullRate, 0);
      assert.equal(field.typeErrors, 0);
      assert.deepEqual(field.sampleRefs, []);
    }
  });

  it("breaches when the null rate is above the field limit", () => {
    const c = contract({
      minRows: 1,
      fields: { brand: { type: "string", maxNullRate: 0.2, minLength: 2 } },
    });
    // 3/10 = 0.3, just above the 0.2 limit
    const report = checkContract(
      c,
      rows(10, (row, i) => (i < 3 ? { ...row, brand: null } : row)),
      10,
      frozenNow
    );
    assert.equal(report.passed, false);
    const brand = fieldNamed(report, "brand");
    assert.equal(brand.nullRate, 0.3);
    assert.equal(brand.nullRateLimit, 0.2);
    assert.equal(brand.breached, true);
    assert.ok(report.breaches.some((b) => b.includes("brand") && b.includes("null rate")));
  });

  it("does not breach when the null rate is at the field limit", () => {
    const c = contract({
      minRows: 1,
      fields: { brand: { type: "string", maxNullRate: 0.2, minLength: 2 } },
    });
    // 2/10 = 0.2, at the limit. The comparison is exclusive (rate > limit).
    const report = checkContract(
      c,
      rows(10, (row, i) => (i < 2 ? { ...row, brand: null } : row)),
      10,
      frozenNow
    );
    assert.equal(report.passed, true);
    const brand = fieldNamed(report, "brand");
    assert.equal(brand.nullRate, 0.2);
    assert.equal(brand.breached, false);
  });

  it("treats empty strings as null", () => {
    const c = contract({
      minRows: 1,
      fields: { brand: { type: "string", maxNullRate: 0, minLength: 2 } },
    });
    const report = checkContract(c, [candidate({ brand: "" })], 1, frozenNow);
    const brand = fieldNamed(report, "brand");
    assert.equal(brand.nullRate, 1);
    assert.equal(brand.breached, true);
    assert.equal(brand.typeErrors, 0);
  });

  it("treats whitespace-only strings as null", () => {
    const c = contract({
      minRows: 1,
      fields: { brand: { type: "string", maxNullRate: 0, minLength: 2 } },
    });
    const report = checkContract(c, [candidate({ brand: " \t \n " })], 1, frozenNow);
    const brand = fieldNamed(report, "brand");
    assert.equal(brand.nullRate, 1);
    assert.equal(brand.breached, true);
    assert.equal(brand.typeErrors, 0);
  });

  it("treats a value shorter than minLength as null", () => {
    const c = contract({
      minRows: 1,
      fields: { brand: { type: "string", maxNullRate: 0, minLength: 4 } },
    });
    const report = checkContract(c, [candidate({ brand: "ab" })], 1, frozenNow);
    const brand = fieldNamed(report, "brand");
    assert.equal(brand.nullRate, 1);
    assert.equal(brand.breached, true);
    assert.equal(brand.typeErrors, 0);
  });

  it("rejects a full ISO datetime for type date", () => {
    const c = contract({
      minRows: 1,
      fields: { published: { type: "date", maxNullRate: 0 } },
    });
    const report = checkContract(
      c,
      [candidate({ published: "2026-08-08T00:00:00.000Z" })],
      1,
      frozenNow
    );
    const published = fieldNamed(report, "published");
    assert.equal(published.nullRate, 0);
    assert.equal(published.typeErrors, 1);
    assert.equal(published.breached, true);
    assert.ok(report.breaches.some((b) => b.includes("published") && b.includes("date")));
  });

  it("accepts a date-only ISO value for type date", () => {
    const c = contract({
      minRows: 1,
      fields: { published: { type: "date", maxNullRate: 0 } },
    });
    const report = checkContract(c, [candidate({ published: "2026-08-08" })], 1, frozenNow);
    const published = fieldNamed(report, "published");
    assert.equal(published.breached, false);
    assert.equal(published.typeErrors, 0);
    assert.equal(report.passed, true);
  });

  it("rejects an enum value outside the allowed set", () => {
    const c = contract({
      minRows: 1,
      fields: {
        risk: {
          type: "enum",
          maxNullRate: 0,
          values: ["Serious", "High", "Medium", "Low"],
        },
      },
    });
    const report = checkContract(c, [candidate({ risk: "Unknown" })], 1, frozenNow);
    const risk = fieldNamed(report, "risk");
    assert.equal(risk.typeErrors, 1);
    assert.equal(risk.breached, true);
    assert.equal(risk.nullRate, 0);
    assert.ok(report.breaches.some((b) => b.includes("risk") && b.includes("enum")));
  });

  it("breaches a row-count cliff from 12 to 8 at maxRowDropRate 0.2", () => {
    const c = contract({ minRows: 1, maxRowDropRate: 0.2 });
    const report = checkContract(c, rows(8), 12, frozenNow);
    assert.equal(report.passed, false);
    assert.equal(report.rowDropRate, (12 - 8) / 12);
    assert.ok(report.breaches.some((b) => b.startsWith("row count fell")));
  });

  it("does not breach a 12 to 11 drop at maxRowDropRate 0.2", () => {
    const c = contract({ minRows: 1, maxRowDropRate: 0.2 });
    const report = checkContract(c, rows(11), 12, frozenNow);
    assert.equal(report.passed, true);
    assert.equal(report.rowDropRate, (12 - 11) / 12);
    assert.ok(!report.breaches.some((b) => b.startsWith("row count fell")));
  });

  it("breaches when rows are below minRows", () => {
    const c = contract({ minRows: 10, maxRowDropRate: 1 });
    const report = checkContract(c, rows(8), 8, frozenNow);
    assert.equal(report.passed, false);
    assert.ok(report.breaches.some((b) => b.includes("at least 10")));
  });

  it("yields a null rate of 1 on zero rows rather than NaN", () => {
    const c = contract({
      minRows: 1,
      maxRowDropRate: 1,
      fields: { brand: { type: "string", maxNullRate: 0, minLength: 2 } },
    });
    const report = checkContract(c, [], 12, frozenNow);
    const brand = fieldNamed(report, "brand");
    assert.equal(brand.nullRate, 1);
    assert.equal(Number.isNaN(brand.nullRate), false);
    assert.equal(report.rows, 0);
    assert.equal(report.passed, false);
  });

  it("populates sampleRefs for offending rows", () => {
    const c = contract({
      minRows: 1,
      fields: { brand: { type: "string", maxNullRate: 0, minLength: 2 } },
    });
    const report = checkContract(
      c,
      [
        candidate({ ref: "ARC-0001", brand: null }),
        candidate({ ref: "ARC-0002", brand: "Acme Home" }),
      ],
      2,
      frozenNow
    );
    const brand = fieldNamed(report, "brand");
    assert.deepEqual(brand.sampleRefs, ["ARC-0001"]);
  });

  it("caps sampleRefs at 3", () => {
    const c = contract({
      minRows: 1,
      fields: { brand: { type: "string", maxNullRate: 0, minLength: 2 } },
    });
    const report = checkContract(
      c,
      rows(5, (row) => ({ ...row, brand: null })),
      5,
      frozenNow
    );
    const brand = fieldNamed(report, "brand");
    assert.equal(brand.sampleRefs.length, 3);
    assert.deepEqual(brand.sampleRefs, ["ARC-0001", "ARC-0002", "ARC-0003"]);
  });
});

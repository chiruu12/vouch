import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkContract } from "../contract.js";
import { CPSC_CONTRACT, normaliseCpsc } from "./cpsc.js";

const sample = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/cpsc-sample.json"), "utf8")
) as unknown;

describe("normaliseCpsc", () => {
  it("returns 6 records, each with a non-null ref, title and permalink", () => {
    const rows = normaliseCpsc(sample);
    assert.equal(rows.length, 6);
    for (const r of rows) {
      assert.ok(r.ref);
      assert.ok(r.title);
      assert.ok(r.permalink);
    }
  });

  it("truncates published to a date-only ISO string", () => {
    for (const r of normaliseCpsc(sample)) {
      assert.equal(typeof r.published, "string");
      if (r.published === null) assert.fail("published is null");
      assert.match(r.published, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("normalises empty strings to null", () => {
    // Products[0].Type is "" on every sample row.
    for (const r of normaliseCpsc(sample)) {
      assert.equal(r.category, null);
    }
  });

  it("does not throw on missing or empty Hazards/Products/Remedies", () => {
    assert.doesNotThrow(() => normaliseCpsc({}));
    assert.doesNotThrow(() => normaliseCpsc({ Products: [] }));
    assert.doesNotThrow(() =>
      normaliseCpsc({
        RecallNumber: "1",
        Title: "Acme Recalls Widgets",
        URL: "https://example.com/1",
        Hazards: [],
        Products: [],
        Remedies: [],
      })
    );
    assert.doesNotThrow(() =>
      normaliseCpsc({
        RecallNumber: "2",
        Title: "Acme Recalls Widgets",
        URL: "https://example.com/2",
        Hazards: null,
        Products: null,
        Remedies: null,
      })
    );
  });

  it("wraps a single object into a one-element array", () => {
    const rows = normaliseCpsc({
      RecallNumber: "1",
      Title: "Acme Recalls Widgets",
      URL: "https://example.com/1",
    });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.ref, "1");
  });

  it("passes the calibrated contract on the real sample", () => {
    const report = checkContract(CPSC_CONTRACT, normaliseCpsc(sample), null);
    assert.equal(report.passed, true, report.breaches.join("; "));
  });
});

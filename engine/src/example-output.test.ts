// Does docs/example-output.md actually contain what it says it does?
//
// That document opens by claiming every excerpt is copied from the published snapshot
// and that nothing in it is illustrative. An audit found two places where it was not:
// a `matchedTokens` array shortened from six entries to four with no ellipsis, and a
// `withdrawnRefs` array reordered. Neither was a lie anybody told on purpose; both were
// a value typed out by hand next to a sentence promising it had not been.
//
// A document asserting it is verbatim is the last thing anyone rereads, so the claim is
// checked here instead. Every JSON block in the file is parsed and every leaf compared
// against the snapshot and the incident records it came from.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

const DOC = readFileSync(join(ROOT, "docs", "example-output.md"), "utf8");
const SNAP = JSON.parse(readFileSync(join(ROOT, "web", "public", "snapshot.json"), "utf8")) as Record<
  string,
  unknown
>;

const INCIDENTS = readdirSync(join(ROOT, "runs"))
  .filter((f) => f.startsWith("incident-") && f.endsWith(".json"))
  .map((f) => (JSON.parse(readFileSync(join(ROOT, "runs", f), "utf8")) as { incident: Record<string, unknown> }).incident);

/** Every fenced json block in the document. */
function jsonBlocks(md: string): unknown[] {
  const out: unknown[] = [];
  for (const m of md.matchAll(/```json\n([\s\S]*?)```/g)) {
    const body = m[1];
    if (body === undefined) continue;
    // Excerpts elide long strings with a trailing "..." inside the value. Those are
    // marked and checked separately below; here they are made parseable.
    try {
      out.push(JSON.parse(body));
    } catch (e) {
      throw new Error(`unparseable json block in example-output.md: ${(e as Error).message}\n${body.slice(0, 200)}`);
    }
  }
  return out;
}

/** Find the record in the snapshot or incidents that an excerpt claims to be. */
function sourceRecordFor(excerpt: Record<string, unknown>): Record<string, unknown> | null {
  const recalls = (SNAP.recalls ?? []) as Record<string, unknown>[];
  if (typeof excerpt.ref === "string") {
    return recalls.find((r) => r.ref === excerpt.ref) ?? null;
  }
  if (typeof excerpt.id === "string") {
    const id = excerpt.id;
    const inc = INCIDENTS.find((i) => `${String(i.sourceId)}-` !== "" && id.startsWith(String(i.sourceId)) && id.includes(String(i.openedAt ?? "")) === false);
    // Incidents are addressed by their file-derived id, which the snapshot carries.
    const fromSnap = ((SNAP.incidents ?? []) as Record<string, unknown>[]).find((i) => i.id === id);
    if (fromSnap !== undefined) return fromSnap;
    const source = ((SNAP.sources ?? []) as Record<string, unknown>[]).find((s) => s.id === id);
    if (source !== undefined) return source;
    for (const r of recalls) {
      for (const key of ["onSale", "quarantined"]) {
        const found = ((r[key] ?? []) as Record<string, unknown>[]).find((l) => l.id === id);
        if (found !== undefined) return found;
      }
    }
    if (inc !== undefined) return inc;
  }
  return null;
}

/** Compare every leaf the excerpt states, ignoring keys it chose to omit. */
function assertSubset(excerpt: unknown, actual: unknown, path: string): void {
  if (Array.isArray(excerpt)) {
    assert.ok(Array.isArray(actual), `${path}: excerpt has an array, record does not`);
    assert.equal(
      excerpt.length,
      (actual as unknown[]).length,
      `${path}: array has ${excerpt.length} entries, the record has ${(actual as unknown[]).length}. ` +
        `An excerpt may omit a key from an object; it may not quietly shorten an array.`
    );
    const objects = excerpt.every((x) => x !== null && typeof x === "object" && !Array.isArray(x));
    if (objects) {
      // An element may state a subset of its keys, the way the top-level excerpts do.
      excerpt.forEach((x, i) => assertSubset(x, (actual as unknown[])[i], `${path}[${i}]`));
      return;
    }
    // A list of plain values is the whole value. This is the comparison that caught
    // matchedTokens being trimmed from six entries to four.
    assert.deepEqual(excerpt, actual, `${path}: differs from the record, in order or content`);
    return;
  }
  if (excerpt !== null && typeof excerpt === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${path}: excerpt has an object, record does not`);
    for (const [k, v] of Object.entries(excerpt as Record<string, unknown>)) {
      const a = (actual as Record<string, unknown>)[k];
      assert.ok(k in (actual as Record<string, unknown>), `${path}.${k}: not present in the record at all`);
      assertSubset(v, a, `${path}.${k}`);
    }
    return;
  }
  if (typeof excerpt === "string" && excerpt.endsWith("...")) {
    // A deliberately elided string, marked with a trailing ellipsis.
    const head = excerpt.slice(0, -3);
    assert.equal(typeof actual, "string", `${path}: elided value is not a string in the record`);
    assert.ok(
      (actual as string).startsWith(head),
      `${path}: elided excerpt does not match the start of the record's value`
    );
    return;
  }
  assert.deepEqual(excerpt, actual, `${path}: differs from the record`);
}

describe("docs/example-output.md says it is verbatim", () => {
  it("parses as json in every fenced block", () => {
    const blocks = jsonBlocks(DOC);
    assert.ok(blocks.length >= 5, `expected the documented excerpts, found ${blocks.length}`);
  });

  it("matches the published records leaf for leaf", () => {
    let checked = 0;
    for (const [n, block] of jsonBlocks(DOC).entries()) {
      if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
      const excerpt = block as Record<string, unknown>;
      const actual = sourceRecordFor(excerpt);
      assert.ok(
        actual !== null,
        `block ${n + 1}: no record in the snapshot or incidents matches this excerpt's id/ref`
      );
      assertSubset(excerpt, actual, `block ${n + 1}`);
      checked++;
    }
    assert.ok(checked >= 5, `only ${checked} excerpts were traced back to a record`);
  });
});

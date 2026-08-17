// The snapshot is the only thing that reaches the public feed, so the guarantees the
// project makes have to hold at this boundary rather than in the templates that
// consume it. Three of them are checked here.
//
// These tests read the real state files under runs/. That is deliberate: a test over
// a hand-built fixture would prove the serialiser is capable of behaving, not that
// the thing we are about to publish actually does. When runs/ is empty (a fresh
// clone) the assertions still hold, because the shape is what is being asserted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, type PubListing, type PubRecall } from "./snapshot.js";
import { PUBLISH_THRESHOLD } from "./match.js";

const snap = buildSnapshot(new Date("2026-08-18T09:00:00.000Z"));

function everyListing(): PubListing[] {
  return [
    ...snap.recalls.flatMap((r: PubRecall) => [...r.onSale, ...r.quarantined]),
    ...snap.withdrawn,
  ];
}

test("no seller identity of any kind reaches the snapshot", () => {
  // Checked over the serialised text rather than the objects, because the leak we are
  // guarding against is a field surviving a spread we forgot to narrow. A key-by-key
  // walk would only inspect the keys we thought to look at.
  const json = JSON.stringify(snap);
  for (const banned of ["sellerKey", "seller_name", "\"seller\"", "sk_"]) {
    assert.equal(
      json.includes(banned),
      false,
      `snapshot contains "${banned}"; seller identity must never be published (decisions.md §7)`
    );
  }
});

test("every published record carries a trust state and a contract version", () => {
  const records: { provenance: { trust: string; contractVersion: string; sourceId: string } }[] = [
    ...snap.recalls,
    ...everyListing(),
  ];
  assert.ok(records.length > 0, "snapshot published nothing, so it proves nothing");

  const allowed = new Set(["verified", "healed", "unverified", "withdrawn"]);
  for (const r of records) {
    assert.ok(allowed.has(r.provenance.trust), `unknown trust state "${r.provenance.trust}"`);
    assert.match(r.provenance.contractVersion, /@\d+$/, "contract version must be pinned, e.g. cpsc@1");
  }
});

test("nothing below the publish threshold is asserted, and every hold-back states why", () => {
  for (const r of snap.recalls) {
    for (const l of r.onSale) {
      assert.ok(l.match !== undefined, `${l.id} is on a recall's onSale list with no match record`);
      assert.ok(
        l.match.confidence >= PUBLISH_THRESHOLD,
        `${l.id} asserted at ${l.match.confidence}, below the ${PUBLISH_THRESHOLD} threshold`
      );
      assert.equal(l.match.contradiction, null, `${l.id} asserted despite a stated contradiction`);
    }
    for (const l of r.quarantined) {
      assert.ok(l.match !== undefined, `${l.id} quarantined with no match record`);
      assert.equal(l.match.publishable, false, `${l.id} is in quarantine but flagged publishable`);
      const explained = l.match.contradiction !== null || l.match.confidence < PUBLISH_THRESHOLD;
      assert.ok(explained, `${l.id} quarantined without a reason a reader could check`);
    }
  }
});

test("a withdrawn listing is never presented as available", () => {
  const liveIds = new Set(snap.recalls.flatMap((r) => r.onSale.map((l) => l.id)));
  for (const w of snap.withdrawn) {
    assert.equal(w.provenance.trust, "withdrawn");
    assert.equal(
      liveIds.has(w.id),
      false,
      `${w.id} was withdrawn at source and is also being asserted as on sale`
    );
  }
});

test("every refusal in the incident log keeps its evidence verbatim", () => {
  for (const i of snap.incidents) {
    if (i.refusal === null) continue;
    assert.ok(i.evidence.length > 0, `incident ${i.id} refused with no evidence recorded`);
    // A refusal that heals anyway is the bug the whole project is about.
    if (i.cause === "gone" || i.cause === "blocked") {
      assert.equal(i.healAttempted, false, `incident ${i.id} healed a "${i.cause}" diagnosis`);
    }
  }
});

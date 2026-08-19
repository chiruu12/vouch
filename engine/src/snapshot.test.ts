// The snapshot is the only thing that reaches the public feed, so the guarantees the
// project makes have to hold at this boundary rather than in the templates that
// consume it. Three of them are checked here.
//
// These tests read the real state files under runs/. That is deliberate: a test over
// a hand-built fixture would prove the serialiser is capable of behaving, not that
// the thing we are about to publish actually does. When runs/ is empty (a fresh
// clone) the assertions still hold, because the shape is what is being asserted.

import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, type PubListing, type PubRecall } from "./snapshot.js";
import { deriveTrust, samePlaceWeScraped } from "./trust.js";
import { TRADEWELL_CONTRACT } from "./sources/tradewell.js";
import type { SourceState } from "./runner.js";
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

// One word doing two jobs.
//
// The health strip derived trust from the contract while every listing under it was
// handed the literal string "verified". During a degraded cycle the strip read FAIL and
// the records beneath it read verified, which is the feed contradicting itself on the
// only claim it exists to make. Both now go through deriveTrust, so these pin the cases
// that separate them.
describe("what the feed is willing to say about a record", () => {
  const rows = (n: number, over: Record<string, unknown> = {}): Record<string, unknown>[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `TW-1000${i}`,
      permalink: `https://tradewell-market.vercel.app/item/TW-1000${i}.html`,
      title: `A listing number ${i}`,
      brand: "Zimtown",
      price: 34,
      condition: "New",
      location: "Boise, ID",
      listedOn: "2026-07-30",
      ...over,
    }));

  const state = (over: Partial<SourceState> = {}): SourceState => ({
    streak: null,
    cooldownUntil: null,
    baselineRefs: [],
    baselineRows: 12,
    lastVerifiedAt: "2026-08-18T08:48:18.707Z",
    lastGoodRows: [],
    healHistory: [],
    withdrawnRefs: [],
    ...over,
  });

  it("says verified when the contract passes", () => {
    assert.equal(deriveTrust(TRADEWELL_CONTRACT, rows(12), state()), "verified");
  });

  it("says unverified when a field breached, which is the case that was impossible before", () => {
    // Kimi's reproduction: null out condition on the rows the runner would be serving
    // stale after a degraded cycle. The strip said FAIL, every record said verified.
    assert.equal(deriveTrust(TRADEWELL_CONTRACT, rows(12, { condition: null }), state()), "unverified");
  });

  it("says healed once a repair has been verified behind these rows", () => {
    const healed = state({
      healHistory: [
        {
          at: "2026-08-18T00:00:00.000Z",
          cause: "drift",
          prompt: "fix the selectors",
          collectorId: "c_test",
          durationMs: 1000,
          verified: true,
          promoted: true,
        },
      ],
    });
    assert.equal(deriveTrust(TRADEWELL_CONTRACT, rows(12), healed), "healed");
  });

  it("keeps vouching for survivors when the only breach is volume explained by withdrawals", () => {
    // The rows we did read were read cleanly. A record 404ing does not un-verify them.
    const withWithdrawals = state({ withdrawnRefs: ["TW-88214", "TW-44903", "TW-33887"] });
    assert.equal(deriveTrust(TRADEWELL_CONTRACT, rows(10), withWithdrawals), "verified");
  });

  it("still says unverified when rows are missing and nothing accounts for them", () => {
    assert.equal(deriveTrust(TRADEWELL_CONTRACT, rows(4), state()), "unverified");
  });

  it("refuses to let one withdrawal excuse a drop of five", () => {
    // The bug this replaces: any withdrawal at all vouched for any volume breach. Seven
    // rows out of a baseline of twelve with a single record taken down means five records
    // stopped extracting and nobody noticed. The rows are read cleanly, which is what made
    // it look fine, and cleanly read is not the same as complete.
    const oneWithdrawal = state({ withdrawnRefs: ["TW-88214"] });
    assert.equal(deriveTrust(TRADEWELL_CONTRACT, rows(7), oneWithdrawal), "unverified");
    // The same seven rows with the drop fully accounted for are still vouched for.
    const five = state({ withdrawnRefs: ["a", "b", "c", "d", "e"] });
    assert.equal(deriveTrust(TRADEWELL_CONTRACT, rows(7), five), "verified");
  });
});

// The link under the trust pill.
describe("a permalink we are willing to publish", () => {
  const SRC = "https://tradewell-market.vercel.app/";

  it("keeps a link on the site we actually scraped", () => {
    const ok = "https://tradewell-market.vercel.app/item/TW-33887.html";
    assert.equal(samePlaceWeScraped(ok, SRC), ok);
  });

  it("rejects a lookalike host that only shares a prefix", () => {
    // 84 characters, so it clears the contract's minLength of 20, and it reads almost
    // exactly like the real thing at a glance. A reader clicking a "verified" recall
    // listing would land on someone else's site entirely.
    const evil = "https://tradewell-market.vercel.app.phish-example.invalid/item/TW-77301.html";
    assert.equal(samePlaceWeScraped(evil, SRC), null);
  });

  it("rejects a different site outright", () => {
    assert.equal(samePlaceWeScraped("https://example.invalid/item/TW-1.html", SRC), null);
  });

  it("rejects a downgrade to http on the very same host", () => {
    // The host check cannot see this one: the host is identical, which is exactly what
    // makes it worth its own refusal. Publishing it would hand a reader an unencrypted
    // link under a label saying we verified where it goes.
    assert.equal(samePlaceWeScraped("http://tradewell-market.vercel.app/item/TW-33887.html", SRC), null);
  });

  it("keeps an upgrade to https from a source served over http", () => {
    // The other direction is not a downgrade, and refusing it would throw away a better
    // link than the one we hold.
    const up = "https://plain-market.example/item/1.html";
    assert.equal(samePlaceWeScraped(up, "http://plain-market.example/"), up);
  });

  it("rejects a scheme that is not web traffic, without relying on the framework", () => {
    assert.equal(samePlaceWeScraped("javascript:alert(document.domain)", SRC), null);
    assert.equal(samePlaceWeScraped("data:text/html,<h1>hi</h1>", SRC), null);
  });

  it("rejects something that is not a URL at all", () => {
    assert.equal(samePlaceWeScraped("a string that is over twenty characters", SRC), null);
  });

  it("passes null through", () => {
    assert.equal(samePlaceWeScraped(null, SRC), null);
  });
});

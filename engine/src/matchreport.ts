// Run the matcher over real recalls and real listings and report what it found,
// including what it did not.
//
// This exists because the project's central claim is a number we did not know until
// we measured it. It prints the confidence distribution, the quarantined near-misses,
// and a sample of matched tokens, so the rate can be judged rather than trusted. A
// low rate reported honestly is a result; a high rate produced by tuning the fixture
// until it flattered us would not be.
//
//   node --import tsx src/matchreport.ts

import { readFileSync } from "node:fs";
import { normaliseCpsc } from "./sources/cpsc.js";
import { normaliseEbay } from "./sources/ebay.js";
import { matchListings, PUBLISH_THRESHOLD, type Match } from "./match.js";
import type { RecallRecord } from "./types.js";

function load(rel: string): unknown {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
}

/** The matcher wants full RecallRecords; provenance plays no part in matching, so a
 *  placeholder keeps the shape honest without pretending we scraped these. */
function withProvenance(c: Omit<RecallRecord, "provenance">): RecallRecord {
  return {
    ...c,
    provenance: {
      sourceId: "cpsc",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      contractVersion: "cpsc@1",
      state: "verified",
      lastVerifiedAt: "2026-08-17T00:00:00.000Z",
      healHistory: [],
    },
  };
}

const recalls = normaliseCpsc(load("../test/fixtures/cpsc-sample.json")).map(withProvenance);
const listings = normaliseEbay(load("../samples/ebay-pressure-washer.json"));

const matches = matchListings(recalls, listings);
const publishable = matches.filter((m) => m.publishable);
const quarantined = matches.filter((m) => !m.publishable);

const byBasis = new Map<string, number>();
for (const m of matches) byBasis.set(m.basis, (byBasis.get(m.basis) ?? 0) + 1);

const pct = (n: number, d: number) => (d === 0 ? "0.0%" : `${((n / d) * 100).toFixed(1)}%`);

console.log("=== inputs ===");
console.log(`recalls (CPSC, real)      ${recalls.length}`);
console.log(`listings (eBay, real)     ${listings.length}`);
console.log(`publish threshold         ${PUBLISH_THRESHOLD}`);

console.log("\n=== result ===");
console.log(`listings with any match   ${matches.length} (${pct(matches.length, listings.length)})`);
console.log(`  publishable             ${publishable.length} (${pct(publishable.length, listings.length)})`);
console.log(`  quarantined             ${quarantined.length} (${pct(quarantined.length, listings.length)})`);
console.log(`no match at all           ${listings.length - matches.length}`);

console.log("\n=== by basis ===");
for (const [basis, n] of [...byBasis.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${basis.padEnd(14)} ${String(n).padStart(4)}`);
}

const byId = new Map(listings.map((l) => [l.id, l]));
const byRef = new Map(recalls.map((r) => [r.ref, r]));

function show(label: string, rows: Match[], limit: number): void {
  console.log(`\n=== ${label} (showing ${Math.min(limit, rows.length)} of ${rows.length}) ===`);
  for (const m of rows.slice(0, limit)) {
    const listing = byId.get(m.listingId);
    const recall = byRef.get(m.recallRef);
    console.log(`  [${m.confidence.toFixed(2)} ${m.basis}]`);
    console.log(`    recall  ${(recall?.brand ?? "?") + " | " + (recall?.title ?? m.recallRef).slice(0, 88)}`);
    console.log(`    listing ${(listing?.title ?? m.listingId).slice(0, 88)}`);
    console.log(`    tokens  ${m.matchedTokens.join(", ")}`);
  }
}

show("publishable", publishable, 8);
show("quarantined", quarantined, 6);

console.log("\n=== recalls that matched nothing ===");
const matchedRefs = new Set(matches.map((m) => m.recallRef));
for (const r of recalls) {
  if (!matchedRefs.has(r.ref)) {
    console.log(`  ${r.ref}  ${(r.brand ?? "?")} | ${r.title.slice(0, 84)}`);
  }
}

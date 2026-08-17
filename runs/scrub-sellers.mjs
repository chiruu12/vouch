// Redact seller identity from captured marketplace output before it is committed.
//
// The eBay collector returns `seller_name`. Some eBay sellers are private
// individuals, and this repository is public, so committing the raw capture would
// publish exactly the identities decision #7 says we never publish. Test fixtures
// are not an exemption from that rule.
//
// seller_name becomes `sellerKey`: a truncated SHA-256 that is stable enough to
// de-duplicate several listings from one seller, and carries no way back to who
// they are. That is the same shape `Listing.sellerKey` expects, so the scrubbed
// capture exercises the real code path rather than a softened one.
//
// Usage: node runs/scrub-sellers.mjs <in.json> <out.json>

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node runs/scrub-sellers.mjs <in.json> <out.json>");
  process.exit(1);
}

const sellerKey = (name) =>
  "sk_" + createHash("sha256").update(String(name).trim().toLowerCase()).digest("hex").slice(0, 12);

const rows = JSON.parse(readFileSync(inPath, "utf8"));
let redacted = 0;

const scrubbed = rows.map((row) => {
  const { seller_name, ...rest } = row;
  if (seller_name === undefined) return rest;
  redacted++;
  return { ...rest, sellerKey: sellerKey(seller_name) };
});

writeFileSync(outPath, JSON.stringify(scrubbed, null, 2) + "\n");

const distinct = new Set(scrubbed.map((r) => r.sellerKey).filter(Boolean)).size;
console.log(`rows: ${scrubbed.length}`);
console.log(`seller_name redacted: ${redacted}`);
console.log(`distinct sellers: ${distinct}`);

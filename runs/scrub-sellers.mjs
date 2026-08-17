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

// Two shapes seen so far: eBay puts `seller_name` at the top level, Tradewell puts
// `seller` inside a nested `results[]`. A scrub that only knew the first shape would
// report success while publishing every name from the second.
function scrubRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "seller_name" || k === "seller") {
      redacted++;
      out.sellerKey = sellerKey(v);
    } else if (k === "results" && Array.isArray(v)) {
      out.results = v.map((r) => (typeof r === "object" && r !== null ? scrubRow(r) : r));
    } else {
      out[k] = v;
    }
  }
  return out;
}

const scrubbed = rows.map(scrubRow);

writeFileSync(outPath, JSON.stringify(scrubbed, null, 2) + "\n");

const flat = scrubbed.flatMap((r) => (Array.isArray(r.results) ? r.results : [r]));
const distinct = new Set(flat.map((r) => r.sellerKey).filter(Boolean)).size;
console.log(`rows: ${scrubbed.length}`);
console.log(`seller fields redacted: ${redacted}`);
console.log(`distinct sellers: ${distinct}`);

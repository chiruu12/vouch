// The registry that decides what is supervised at all.
//
// `SOURCES` in cycle.ts had no test, and could not have one: importing the module ran a
// live cycle. So every field in it was load-bearing and unchecked at once. That is a bad
// combination, because the failures are quiet ones. A contract keyed to the wrong source
// measures the wrong thing and passes. A permalink built on the wrong origin probes a
// site we are not looking at, and 404s there read as withdrawals of records that were
// never in danger. A source marked repairable with no collector behind it sends a heal
// prompt at nothing and records the attempt as if it happened.
//
// None of those show up as a crash. They show up as a feed that is confidently wrong,
// which is the one outcome this project exists to prevent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCES } from "./cycle.js";
import type { SourceId } from "./types.js";

const entries = Object.entries(SOURCES) as [SourceId, NonNullable<(typeof SOURCES)[SourceId]>][];

test("the registry is not empty and every contract is keyed to its own source", () => {
  assert.ok(entries.length > 0, "an empty registry would make every check below vacuous");
  for (const [id, w] of entries) {
    assert.equal(
      w.contract.sourceId,
      id,
      `${id} is supervised against contract ${w.contract.version}, which is written for ${w.contract.sourceId}`
    );
  }
});

test("nothing is repairable that has no collector to rewrite", () => {
  // The invariant behind CPSC's `repairable: false`, stated generally. A repair rewrites
  // a Bright Data collector. A source we fetch ourselves has none, so the honest answer
  // to a break there is a refusal and a person, not a prompt sent nowhere.
  let fetched = 0;
  for (const [id, w] of entries) {
    const hasCollector = w.collectorId !== "";
    assert.ok(
      hasCollector || w.collect !== undefined,
      `${id} has neither a collector id nor a collect(), so a cycle for it cannot fetch anything`
    );
    if (!hasCollector) {
      fetched++;
      assert.equal(w.repairable, false, `${id} is fetched directly and must not claim to be repairable`);
    }
  }
  assert.ok(fetched > 0, "no directly-fetched source is registered, so this rule proved nothing");
});

test("a scraped source builds its withdrawal oracle on the origin it was handed", () => {
  // The withdrawal oracle, and the direction that costs the most. `permalinkFor` takes
  // the origin actually being crawled rather than hardcoding one, because a fixture can
  // be redeployed: point `--url` at a second deployment and a permalink built from the
  // hardcoded production origin probes the wrong site, where a 404 reads as a withdrawal
  // of a record that was never in danger.
  //
  // A source we fetch ourselves is exempt, and the exemption is the point rather than a
  // way around the rule. There is one CPSC. Its API lives on saferproducts.gov and its
  // notices on cpsc.gov, both genuinely CPSC and neither redeployable, so honouring an
  // origin argument would mean building a notice URL on an API host. What it still owes
  // is below: a real https link that names the record.
  let retargeted = 0;
  let hardcoded = 0;
  const elsewhere = "https://example.invalid";

  for (const [id, w] of entries) {
    const own = new URL(w.url).origin;
    const link = w.permalinkFor("REF-1", own);
    if (link === null) continue;

    assert.ok(link.includes("REF-1"), `${id} builds a permalink that does not name the record`);
    assert.equal(new URL(link).protocol, "https:", `${id} probes for withdrawals over ${new URL(link).protocol}`);

    if (w.collectorId !== "") {
      retargeted++;
      assert.equal(
        w.permalinkFor("REF-1", elsewhere),
        `${elsewhere}${link.slice(own.length)}`,
        `${id} is scraped and ignores the origin it was given, so a second deployment probes the first`
      );
    } else {
      hardcoded++;
      assert.equal(
        w.permalinkFor("REF-1", elsewhere),
        link,
        `${id} has no collector and no redeployment story, so its oracle host must not move`
      );
    }
  }

  assert.ok(retargeted > 0, "no scraped source has a permalink oracle, so the retargeting rule proved nothing");
  assert.ok(hardcoded > 0, "no directly-fetched source has a permalink oracle, so the exemption proved nothing");
});

test("a real marketplace is under supervision, not only the fixtures we own", () => {
  // The claim the whole feed rests on is that a recall can be matched against what is
  // actually for sale. Tradewell is a marketplace we built and are allowed to break, so
  // it can demonstrate the machinery and cannot demonstrate that the machinery survives
  // a site that does not know we exist. eBay is the one that can.
  const ebay = SOURCES.ebay;
  assert.ok(ebay, "eBay is not registered, so no real marketplace is supervised");
  assert.equal(ebay.contract.sourceId, "ebay");
  assert.ok(ebay.collectorId.startsWith("c_"), "a real marketplace has to be scraped through a collector");
  // Asserted through the default the runner actually applies, not through the field.
  // eBay does not declare `repairable` at all, so `notEqual(ebay.repairable, false)` was
  // comparing undefined to false: true, and true whatever the wiring said. The question
  // is what the cycle ends up doing, and that is `args.repairable ?? true` in runner.ts.
  assert.equal(ebay.repairable ?? true, true, "eBay has a collector, so a drift there is repairable");
  assert.equal(new URL(ebay.url).origin, "https://www.ebay.com");
  assert.equal(ebay.permalinkFor("116543210987", "https://www.ebay.com"), "https://www.ebay.com/itm/116543210987");
});

# Example structured output

Every excerpt on this page is copied from `web/public/snapshot.json`, which is the file
the feed renders and is committed in this repository. Nothing here is illustrative.

The snapshot is produced by `engine/src/snapshot.ts`, which decides what the feed is
allowed to publish. Regenerate it with `cd engine && node --import tsx src/snapshot.ts`.

## 1. A recall matched to a listing that is still on sale

This is the record the whole system exists to produce. A CPSC recall for a portable fuel
container, matched to a marketplace listing for the same product line.

```json
{
  "ref": "26700",
  "permalink": "https://www.cpsc.gov/Recalls/2026/Fastbuy-Recalls-Zimtown-Portable-Gas-and-Fuel-Cans-...",
  "title": "Fastbuy Recalls Zimtown Portable Gas and Fuel Cans Due to Risk of Serious Injury or Death from Burn Hazard and Child Poisoning; Violate Mandatory Standard for Portable Fuel Containers",
  "brand": "Zimtown",
  "hazard": "The fuel containers violate the requirement for closures under the Children's Gasoline Burn Prevention Act because the closure is not child-resistant, posing a risk of burns and poisoning to children.",
  "risk": "Unknown",
  "onSale": [
    {
      "id": "TW-33887",
      "permalink": "https://tradewell-market.vercel.app/item/TW-33887.html",
      "title": "Zimtown 5 gal portable gas can, red, with spout",
      "brand": "Zimtown",
      "price": 34,
      "currency": null,
      "condition": "New",
      "location": "Boise, ID",
      "listedOn": "2026-07-30",
      "provenance": {
        "sourceId": "tradewell",
        "sourceLabel": "Tradewell Market (synthetic)",
        "scraped": true,
        "synthetic": true,
        "contractVersion": "tradewell@1",
        "trust": "verified",
        "lastVerifiedAt": "2026-08-18T08:48:18.707Z",
        "heals": 0
      },
      "resurrected": {
        "withdrawnAt": "2026-08-17T19:49:05.922Z",
        "backOnSaleAt": "2026-08-18T08:18:35.436Z"
      },
      "match": {
        "confidence": 0.72,
        "basis": "brand+product",
        "matchedTokens": ["zimtown", "portable", "gas", "can"],
        "contradiction": null,
        "publishable": true
      }
    }
  ]
}
```

Four things in that record are worth naming, because each is a decision rather than a
field that happened to be available.

**There is no seller.** `PubListing` has no seller field. The source adapter hashes the
seller name into a `sellerKey` before the engine ever sees it, and the published type
cannot carry even the hash. A template cannot leak what the serialiser cannot emit, and
`web/verify-output.mjs` fails the build if any seller-shaped string reaches the HTML.

**`currency` is null, and the price is not.** The page shows a bare `$` glyph. The
collector read a number and did not read a currency, so the feed publishes the number and
says the currency is missing. Inferring USD from a dollar sign would be putting in data
nobody read.

**`match.publishable` is true at 0.72, and the claim is narrow.** The basis is
`brand+product`, not a lot code. The feed says this listing is for the same product line
as the recall. It never says this unit is a recalled unit, because a resale listing almost
never shows the batch information that would establish it.

**`resurrected` carries two dates.** This record was published as withdrawn on the 17th
after its permalink stopped resolving, and was on sale again on the 18th. Both timestamps
come from the incidents that recorded them, so the claim is checkable against the log
rather than being a flag set at render time.

## 2. A match held back, with the reason

Matches below `0.7` confidence are quarantined rather than dropped, because a silently
discarded near-miss looks the same as never having looked.

```json
{
  "id": "TW-55118",
  "title": "Deli 20L metal jerry can, dark green",
  "match": {
    "confidence": 0.3,
    "basis": "product-only",
    "matchedTokens": ["jerry", "deli"],
    "contradiction": null,
    "publishable": false
  }
}
```

On a real capture of 193 eBay rows, 17 were publishable and 168 were quarantined. The
rate is low on purpose: a false positive here is an accusation, and a false negative is
only a miss.

## 3. A refusal

This is the record type that distinguishes the project. The engine diagnosed a failure it
could repair, and declined to.

```json
{
  "id": "tradewell-1786996150942",
  "sourceId": "tradewell",
  "cause": "gone",
  "openedAt": "2026-08-17T19:49:05.922Z",
  "evidence": [
    "3 notice(s) absent from the listing AND their permalinks return 404 or 410: TW-33887, TW-44903, TW-88214",
    "removed at source, not lost by us: retained as last-good, never healed",
    "all 3 missing record(s) accounted for by withdrawal; remaining 11 rows satisfy contract tradewell@1"
  ],
  "refusal": "records were withdrawn at source and their permalinks no longer resolve; healing would fabricate replacements for records that were deliberately removed",
  "healAttempted": false,
  "healDeferred": false,
  "prompt": null,
  "verified": true,
  "withdrawnRefs": ["TW-88214", "TW-33887", "TW-44903"]
}
```

`prompt` is null because `engine/src/prompt.ts` throws rather than synthesise a repair
instruction for an unrepairable cause. The refusal is not a policy applied after the fact;
there is no prompt to send.

## 4. A repair that was measured and served

```json
{
  "id": "tradewell-drift2-1786998379616",
  "cause": "pagination",
  "healAttempted": true,
  "healDurationMs": 330551,
  "verified": true,
  "mttrMs": 347580
}
```

And one that was measured and thrown away:

```json
{
  "id": "tradewell-1786987328817",
  "cause": "drift",
  "healAttempted": true,
  "verified": false,
  "refusal": "heal reported \"done\" but the result still fails the contract: field id null rate 100.0% exceeds limit 0.0% over 0 rows; field permalink null rate 100.0% exceeds limit 0.0% over 0 rows"
}
```

The second is the more useful record. The vendor reported success and the collector
returned nothing, and the only reason the feed knows that is the re-run.

## 5. Source health

```json
{
  "id": "tradewell",
  "label": "Tradewell Market (synthetic)",
  "scraped": true,
  "synthetic": true,
  "collectorId": "c_msxhnjyoflutq9tt8",
  "contractVersion": "tradewell@1",
  "trust": "verified",
  "rows": 12,
  "baselineRows": 12,
  "contractPassed": true,
  "breaches": [],
  "lastVerifiedAt": "2026-08-18T08:48:18.707Z",
  "withdrawnRefs": ["TW-88214", "TW-44903"],
  "heals": 1
}
```

`synthetic` is a boolean rather than a word in the label, so the feed renders the marker
from the flag. A fixture cannot be mistaken for a real source by a template that forgot to
check the string.

## Top-level shape

```
generatedAt        when this snapshot was published
caveat             the match claim, quoted verbatim wherever a match is shown
publishThreshold   0.7
sources[]          one card per source, with contract state and trust
recalls[]          each with onSale[] and quarantined[] listings
withdrawn[]        listings removed at source, kept as history
incidents[]        every failure and what was done about it
study{}            the 193-row eBay matching study, with quarantine reasons
totals{}           the figures the feed prints
```

The full file is `web/public/snapshot.json`, 45KB, committed.

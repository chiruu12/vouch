# Vouch

A product recall feed that refuses to publish a record it cannot vouch for.

Built for the WeMakeDevs "Into the Scrape-Verse" hackathon, August 2026.

**Live feed: https://vouch-black.vercel.app**

Recalled products keep selling on resale marketplaces long after large retailers pull
them, because a recall notice never reaches the secondhand market. Finding them means
scraping, and scrapers break. The interesting question is not how to repair a broken
scraper. It is how to tell the difference between a scraper that broke and a product
that was deliberately taken down, because repairing the second one publishes a
fabricated safety recall.

## The problem with self-healing scrapers

Point an LLM-driven healer at a page where the data has been removed and it will
obediently find *something* to fill the gap. It has to: you asked it to find the
missing field, so it finds a field. In a safety feed that means republishing a recall
notice that no longer exists, or inventing a listing for a product that was delisted.

There are four reasons a field goes null, and two of them must never be repaired.

| Cause | What is actually happening | Correct action |
| --- | --- | --- |
| `drift` | The data is still published, in a different shape | Repair |
| `pagination` | The listing is intact, the paging scheme moved | Repair |
| `blocked` | A bot wall or rate limit refused the request | Back off. Rewriting selectors cannot clear a block |
| `gone` | The record was withdrawn and its own URL 404s | Never repair. Keep it, mark it withdrawn |

Every self-healing scraper we found treats all four as the first case. The refusal is
the product here, not the repair loop, which is table stakes and well covered by prior
art.

## How it decides

```
probe the listing      before extracting, so a block cannot read as a change
run the collector      a failed run is data, not an exception
check the contract     per-field null rates, type checks, and a row-count cliff
reconcile refs         against the last good run, whether or not the contract passed
probe the permalinks   of anything missing. 404 means withdrawn, 200 means we lost it
classify               into one of the four causes above
repair, or refuse      and record which, with the evidence
verify                 by re-running and re-measuring. The vendor's "done" is not evidence
serve                  only what passed, labelled with what we can say about it
```

Two gates are load-bearing:

**The permalink is the withdrawal oracle.** A record vanishing from a listing page is
ambiguous. The same record's own URL returning 404 is not. That single probe is what
separates `gone` from `drift`, and it is the reason the engine can refuse to repair
without guessing.

**Nothing is served on the vendor's word.** Our first repair returned `status: "done"`
having completed a stage literally named `request_fulfillment_validator`, and the
collector then extracted zero rows. Every repair is followed by a fresh run measured
against the same contract, and the result is only served if that run passes.

## What it publishes, and what it will not

Recalls are usually batch-specific. A notice covers serials 4400 to 6200; a resale
listing almost never shows a lot code. So a title match cannot establish that a listing
is a recalled unit. It can establish that a listing is for the same product line, which
is a weaker claim, and that is the only claim the feed makes.

- Seller identity is hashed at the source adapter and the published record type has no
  field for it. A template cannot leak what the serialiser cannot emit.
- Matches below `0.7` confidence are quarantined, shown with the reason, never asserted.
- A listing stating an attribute the recall rules out is demoted even when brand and
  product agree. A 4-litre fridge is not covered by a recall of the 10 and 15 litre
  models, however well the words line up.

Measured on a real capture: **17 publishable matches out of 193 real eBay listings**,
168 quarantined, 8 with no match at all. The rate is low on purpose. A false positive
here is an accusation and a false negative is only a miss.

## What is real and what is synthetic

Stated plainly because the distinction matters when reading the numbers.

| Source | Real? | How it is fetched |
| --- | --- | --- |
| US CPSC recalls | Real | The CPSC publishes a free JSON API. Not scraped, and the feed says so |
| eBay listings | Real | Bright Data Scraper Studio. 193 listings from one recall-derived query, about 6 minutes, 0 error rows |
| Arcadia Product Safety | Synthetic fixture | Scraper Studio, against a site we built and are allowed to break |
| Tradewell Market | Synthetic fixture | Scraper Studio, same |

We cannot ask a real regulator or marketplace to redesign, bot-block, or delist on cue,
so failure modes are induced against fixtures we own. They are labelled synthetic
everywhere they appear, and their variants replay realistic changes rather than
implausible ones.

Bright Data classifies `www.gov.uk`, `ec.europa.eu` and `recalls-rappels.canada.ca` as
Government and blocks them, which is what pushed the recall side onto official APIs and
the scraping onto the commercial side. That turned out better on every axis: retailer
markup changes constantly where government sites run multi-year redesign cycles, and
marketplaces actually bot-block and delist, so two of the four classifier branches stop
being theoretical.

## Measured behaviour

Every figure below came from a live run against a real Bright Data collector. Raw
timings are in [`runs/timing.log`](runs/timing.log).

| Scenario | Result |
| --- | --- |
| Healthy cycle, Arcadia | 12 rows, contract passed, served verified, 5.6s |
| Healthy cycle, Tradewell | 14 rows, contract passed, served verified, 6.0s |
| Three listings delisted | Contract failed on a 21.4% row-count cliff. Diagnosed `gone`, refused to repair, served the remaining 11 as verified, withdrew the three. 5.0s |
| Anti-bot interstitial at HTTP 200 | Diagnosed `blocked` from the body signature, refused to repair, served last-good as unverified. 38.7s |
| Page redesign that broke paging | Returned 7 rows against a baseline of 14, and all 7 missing records still returned 200 at their own URLs. Diagnosed `pagination`, repaired in 330.6s, re-measured, contract passed, served as `healed`. **MTTR 347.6s** |
| Repair that reported success and returned nothing | Contract still failed after the repair, result rejected, last-good served as unverified |
| Repair that could not start | Diagnosed `pagination` and was ready to repair, but a repair was already running on that collector and the API returned HTTP 409. Recorded as deferred, not as a repair that failed. Nothing was attempted and the collector was left unchanged. Served last-good 14 rows as unverified. 9.1s |
| A withdrawn record back on sale | The marketplace relisted one of three delisted products and its permalink resolved again. 12 rows against a baseline of 11, contract passed, nothing broken. Reported as a `resurrected` incident, dropped from the withdrawn list, served 12 rows verified. 8.3s |

The last of those is the only event here that is not about the scraper at all, and it is
the one a reader of a recall feed most needs. A recalled portable fuel container was
pulled from sale and put back. Nothing broke, the contract passed, and a supervisor that
only watches for breakage has nothing to say about it. The listing now carries the date
it was withdrawn and the date it returned, both read from the incidents that recorded
them, and its recall sorts above every other recall in the feed regardless of risk band.

An earlier full detect, classify, repair and verify cycle on the Arcadia collector
completed in 166s, measured before the account cap. All four failure causes have been
produced against live collectors, and the repairable two are the only two that were
repaired. The two events that are not failures, a deferral and a resurrection, were
produced live as well.

The deferral is worth a note because the vendor's own reporting is what makes it
dangerous. A 409 comes back through the CLI as a trigger failure with zero steps
completed, which is indistinguishable from a repair that ran and failed. Counting it as a
refusal would inflate the number this project is judged on, in the flattering direction.
The lock in the run above was held by a cycle whose client process had been killed
minutes earlier, which is the ordinary way this happens: the job outlives whatever
started it.

The resurrection matters more than its size suggests. The record that came back is a
recalled portable fuel container. Nothing was broken, the contract passed, and before
this existed the feed would have served it again in silence, because a supervisor that
only watches for failures has nothing to say about a source that changes its mind.

The refusal is enforced in code rather than by convention. Flipping the `gone` branch to
healable `drift` fails exactly six tests and nothing else: four on the classifier's
verdict, and two on what the cycle then does, which is the half that actually matters.
One of those two asserts that `deps.heal` is never called, not that its result is
discarded.

## Running it

Start with `npm run demo`. It replays the four causes through the real classifier and
contract with the network dependencies pre-recorded, so the decision is watchable without
a Bright Data account. Every scenario there was produced live first; `runs/timing.log`
has the originals.

```bash
cd engine
npm install
npm run demo                              # watch all four causes decided, no API key
npm test                                  # 110 tests, no network
node --import tsx src/cycle.ts arcadia    # one supervision cycle, needs BRIGHTDATA_API_KEY
node --import tsx src/snapshot.ts         # publish web/public/snapshot.json

cd ../web
npm install
npm run dev                               # the feed
npm run build                             # export, then verify the exported HTML
npm run mutations                         # prove that verifier catches what it claims

# web/public/vercel.json ships with the export, so `vercel deploy` on web/out/
# serves /incidents and /method rather than 404ing on them.
```

`npm run build` ends by running `verify-output.mjs` against the exported HTML. It fails
the build if a string the engine wrote was altered on its way to the page, if a page that
owes a string no longer carries it, if anything is hidden behind a disclosure or CSS, or
if a seller field reached the output.

That script has been wrong four times, and every rule in it exists because a mutation
got past the version before.

1. It concatenated the pages, so a refusal intact on one page satisfied the check for
   the same refusal truncated on another.
2. It then held a page to a string only if the page contained that string's first 40
   characters, so truncating the head instead of the tail dropped the page out of the
   checked set.
3. It stripped `<script>` tags but kept their contents, and a static Next export inlines
   every server-rendered string in the RSC flight payload, so a section could be deleted
   from the page and still be found in its own payload.
4. It asked whether a page contained a string, not how many times. Four sentences render
   twice on the method page, and truncating one left the other to answer for it.

`npm run mutations` re-derives that claim. It applies ten edits that each break a stated
guarantee, rebuilds, and requires the verifier to reject every one. The harness asserts
its own edits landed, because an earlier version of it lost a mutation to shell quoting,
built unmodified source, and reported the hole it had failed to create. A check that
reports success without establishing the property is worse than no check, and that
applies to the check on the check.

The engine has no network calls of its own. Everything that touches the outside world
goes through `CycleDeps`, injected at the entry point, which is why the classifier,
contract and refusal logic are testable without a network at all.

## Layout

```
engine/src/
  classify.ts     the four causes, and which two are repairable. The file this exists for
  contract.ts     per-source contracts: null rates, type checks, row-count cliffs
  prompt.ts       synthesises the repair prompt, and throws rather than emit one for
                  blocked or gone
  runner.ts       one supervision cycle, pure, fully injected
  cycle.ts        the live entry point that supplies the real dependencies
  match.ts        recall to listing, with the basis and the contradictions
  snapshot.ts     what the feed is allowed to publish
  sources/        one adapter per collector. Not ceremony: see docs/decisions.md
web/              the feed, rendering a published snapshot rather than scraping
fixtures/         the synthetic sites, with their drift, delisted and blocked variants
docs/             decisions.md, scraper-studio.md, ai-assistance.md
runs/timing.log   every measurement, written when it was taken
```

## Documents

- [Decisions](docs/decisions.md): the choices that shaped this, and what forced them
- [Working with Scraper Studio](docs/scraper-studio.md): what the tool does well, where
  it surprised us, and the workarounds
- [AI assistance](docs/ai-assistance.md): what was AI-assisted and what was not

## Licence

MIT. See [LICENSE](LICENSE).

## Known limits

- Matching is title-based. It cannot read a lot code off a photo, so batch-level
  certainty is out of reach by construction.
- Three collectors in the account are stuck: one on a repair prompt that was too
  aggressive, and two holding a repair lock that outlived the job that took it. A
  repair can damage a working scraper, and nothing here prevents that beyond refusing to
  serve the result.
- `bdata scraper run --version dev` is unreachable from the CLI, so a repair cannot be
  inspected before it reaches production. The gate sits at serving time instead.
- A resurrection is reported and ranked, but the feed has no way to tell anyone. A
  relisted recalled product sorts to the top of the feed and carries both dates, which
  helps a reader who opens the page and not one who does not. This wants a subscription,
  and there is none.
- Coverage is two recall sources and one marketplace.

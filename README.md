# Vouch

A self-healing recall feed that knows which failures it must not heal.

Built for the WeMakeDevs "Into the Scrape-Verse" hackathon, August 2026.

**Live feed: https://vouch-black.vercel.app** · `cd engine && npm run demo` to watch it decide.

Recalled products keep selling on resale marketplaces long after large retailers pull
them, because a recall notice rarely reaches an individual secondhand seller. Finding
them means scraping, and scrapers break.

## It repairs, and it proves the repair worked

Bright Data Scraper Studio builds and repairs the collectors. This engine supervises
them, and the repair loop runs end to end:

| Measured live | Result |
| --- | --- |
| Page redesign that broke paging | Diagnosed `pagination`, repaired in 330.6s, re-measured, contract passed, served. **MTTR 347.6s** |
| Repair that reported `status: "done"` and returned zero rows | Contract still failed on the re-run. Result rejected, never served |

The second row is why the first one is worth trusting. Our first repair came back
`done`, having completed a stage literally named `request_fulfillment_validator`, and
the collector then extracted nothing. **Nothing is served on the vendor's word.** Every
repair is followed by a fresh run measured against the same contract, and the output is
published only if that run passes.

## Self-healing repairs the scraper. Self-evolution repairs the supervisor

Scraper Studio heals the collector. Something has to maintain the layer that decides
whether to call the healer at all, and on this project that layer drifted faster than the
sites did: three collectors built from near-identical sentences over one fixture returned
three different names for the same field, two days apart, and each time a person patched
an adapter.

So the field names are data now, in `engine/learned/aliases.json`, and `npm run evolve`
derives new ones from the captures. The rule that makes it safe to run unattended is
narrow and worth stating exactly, because "reversible" alone is not enough:

- **Applied automatically.** A name that fills a canonical field currently null in every
  row. It is appended, never inserted, so it cannot change a value the engine already
  reads, and it is undone by deleting one line. Only fields with a distinctive shape
  qualify: an identifier whose values are already in the baseline, a URL that parses, a
  date, a number.
- **Proposed, never applied.** Anything that could weaken a gate or change an existing
  reading. New withdrawal phrases, because a wrong one takes a live recall off the feed.
  Repair prompts, because a bad one has permanently wedged a collector here, and two more
were wedged by repairs that failed to trigger and never released their lock.
- **Never, at any confidence.** Anything touching seller identity, in either direction.

The first dry run of the evolver offered to read a shipping cost as a currency and our
own seller hash as a seller name. Both were reversible; both were nonsense. Reversibility
bounds what a wrong change can cost, it does not make the change right, and the tests in
`evolve.test.ts` are mostly refusals for that reason.

Nothing here can touch `contract.ts`. A system that quietly retunes its own thresholds
until nothing fails would be the exact inversion of this project.

## The two failures a repair must never touch

Repairing is the easy half and it is well covered by prior art. The hard half is knowing
when a repair is the wrong move.

Point an LLM-driven healer at a page where the data has been removed and it will
obediently find *something* to fill the gap. It has to: you asked it to find the missing
field, so it finds a field. In a safety feed that means republishing a recall notice that
no longer exists, or inventing a listing for a product that was delisted.

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
probe the permalinks   of anything missing. 404, 410, a gone page or a redirect away
                       means withdrawn. A clean 200 means we lost it. No answer at all
                       means we cannot say, and nothing is repaired until we can
classify               into one of the four causes above
repair, or refuse      and record which, with the evidence
verify                 by re-running and re-measuring. The vendor's "done" is not evidence
serve                  only what passed, labelled with what we can say about it
```

Two gates carry the weight. The first:

**The permalink is the withdrawal oracle.** A record vanishing from a listing page is
ambiguous. The same record's own URL returning 404 is not. That single probe is what
separates `gone` from `drift`, and it is the reason the engine can refuse to repair
without guessing.

The oracle reads bodies as well as statuses, because a site that answers 200 with a "no
longer available" page would otherwise look identical to a record we simply failed to
read. And when the probe does not answer at all, that is a third state rather than a
default: no repair runs while any missing record is unchecked, since repairing asserts
those records are still published and an unreachable probe is exactly the failure to
establish it. Both holes were found by an adversarial review, not by us.

The second is the verify-then-serve rule described at the top. It is the only thing
standing between a repair that says it worked and a feed that believes it.

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
| US CPSC recalls | Real | The CPSC publishes a free JSON API. Fetched directly, not scraped, and the feed says so. Supervised on the same cycle as everything else: 307 notices, contract `cpsc@1`, permalink withdrawal oracle. A break there is not repairable, because there is no collector to rewrite |
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
| Three listings delisted | Contract failed on a 21.4% row-count cliff. Diagnosed `gone`, refused to repair, served the remaining 11 as verified, withdrew the three. 4.4s |
| Anti-bot interstitial at HTTP 200 | Diagnosed `blocked` from the body signature, refused to repair, served last-good as unverified. 38.7s |
| Page redesign that broke paging | Returned 7 rows against a baseline of 14, and all 7 missing records still returned 200 at their own URLs. Diagnosed `pagination`, repaired in 330.6s, re-measured, contract passed, served as `healed`. **MTTR 347.6s** |
| Repair that reported success and returned nothing | Contract still failed after the repair, result rejected, last-good served as unverified |
| Repair that could not start | Diagnosed `pagination` and was ready to repair, but a repair was already running on that collector and the API returned HTTP 409. Recorded as deferred, not as a repair that failed. Nothing was attempted and the collector was left unchanged. Served last-good 14 rows as unverified. 6.2s |
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

Twelve of those tests run over generated input rather than examples, and two of the
twelve check that the generators still reach the states the other ten depend on:
`classify.fuzz.test.ts` runs 3000 inputs through the classifier and
`runner.fuzz.test.ts` drives 2000 cycles of the state machine, checking invariants like
"a repair is never authorised while any missing record is unaccounted for" and "a
withdrawn ref only ever stops being withdrawn by being reported as resurrected". One of
them found a live defect within seconds of being written, which is described in
`docs/decisions.md`. Both suites assert their own coverage, because a property test that
never reaches the interesting branch passes without checking anything.

The refusal is enforced in code rather than by convention, and that claim is measured
rather than asserted. `engine/verify-mutations.mjs` breaks every safety invariant this project states, one at
a time and requires the suite to go red for each. Flipping the `gone` branch to healable
`drift` fails ten tests: the classifier's verdict, including the soft-404 case where the
record says it is gone in the body rather than the status, and what the cycle then does,
which is the half that actually matters. One of those asserts that `deps.heal` is never
called, not merely that its result is discarded.

The harness earns its place. It was written because this paragraph had said "seven" since
the day it was true, and it found two tests that passed for a reason other than the one
their names gave: a check on Bright Data's own error header that a later status rule was
covering for, and the second lock on the seller field, which no test reached because the
first lock stopped everything before it. Both are now asserted directly.

## Running it

Start with `npm run demo`. It replays the four causes through the real classifier and
contract with the network dependencies pre-recorded, so the decision is watchable without
a Bright Data account. Every scenario there was produced live first; `runs/timing.log`
has the originals.

```bash
cd engine
npm install
npm run demo                              # watch all four causes decided, no API key
npm run ask                               # the same feed answered for an agent
npm run ask -- "cooluli minifridge"       # one question against the published snapshot
npm run mcp                               # serve it over MCP on stdio
npm run evolve -- --dry                   # what the supervisor would teach itself
npm test                                  # the whole suite, no network
npm run mutations                         # break every stated invariant, require red
npm run tokens                            # what one question costs, against a budget
node --import tsx src/cycle.ts cpsc      # one supervision cycle against the live CPSC API
node --import tsx src/cycle.ts arcadia    # same, against a scraped fixture: needs the Bright Data CLI signed in
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

`npm run mutations` re-derives that claim. It applies twelve edits that each break a stated
guarantee, rebuilds, and requires the verifier to reject every one. The harness asserts
its own edits landed, because an earlier version of it lost a mutation to shell quoting,
built unmodified source, and reported the hole it had failed to create. A check that
reports success without establishing the property is worse than no check, and that
applies to the check on the check.

The cycle has no network calls of its own. Everything the runner touches the outside
world with goes through `CycleDeps`, injected at the entry point, which is why the classifier,
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
  oracles.ts      the two questions we ask a page body, and why they are asked differently
  snapshot.ts     what the feed is allowed to publish
  context.ts      what we are entitled to claim when something else is asking
  wire.ts         how cheaply that is spelled. Never what it says
  mcp.ts          the same three answers over MCP, on stdio
  sources/        one adapter per collector. Not ceremony: see docs/decisions.md
web/              the feed, rendering a published snapshot rather than scraping
fixtures/         the synthetic sites, with their drift, delisted and blocked variants
docs/             decisions.md, scraper-studio.md, context-service.md, ai-assistance.md,
                  example-output.md
runs/timing.log   every measurement, written when it was taken
```

## Documents

- [Example structured output](docs/example-output.md): real records from the published
  snapshot, annotated with why each field is shaped the way it is
- [Decisions](docs/decisions.md): the choices that shaped this, and what forced them
- [The context service](docs/context-service.md): the same feed answered for an agent,
  and why a stale source may report a recall but not report finding nothing
- [Working with Scraper Studio](docs/scraper-studio.md): what the tool does well, where
  it surprised us, and the workarounds
- [AI assistance](docs/ai-assistance.md): what was AI-assisted and what was not

## Licence

MIT. See [LICENSE](LICENSE).

## Known limits

- Matching is title-based. It cannot read a lot code off a photo, so batch-level
  certainty is out of reach by construction.
- The withdrawal oracle detects removal, not revision, and it is a liveness probe, so
  three things get past it for the same reason. A recall expanded to cover more units
  returns 200 at the same URL with changed content, and the engine sees a healthy record.
  A recall rescinded at source, or narrowed, does the same. And a notice removed from a
  listing while its own page stays up under an archive policy reads as merely missing,
  which is the state that authorises a repair. All three need per-record content hashing
  rather than a check that the page still answers, and that is the most consequential
  thing still missing.
- Presence survives staleness and absence does not, which is the rule the context service
  is built on, and it holds against a broken pipe rather than against a changed world. A
  notice does not expire, but it can be rescinded, and a source that is stale is exactly
  the source that cannot tell us it happened. A recall retracted while its source is down
  keeps being served as a stale hit until a cycle succeeds.
- `redirectedAway` counts any same-host path change as a withdrawal and compares paths
  only, so the asymmetry runs backwards: a move to a new domain reads as live, while a
  path redesign on the same host reads as withdrawn. A maintenance redirect during a
  cycle where extraction also broke would mark every missing record withdrawn at once.
  Nothing phantom is published, but live recalls would leave the feed.
- The gone markers were chosen for marketplace pages, and recall notices exist to say a
  product is no longer for sale. Phrases like "no longer available" appear in legitimate
  notice bodies. Reading visible text only, and never script payloads, contains this
  rather than solving it.
- At least three real failures are filed as `drift` because there is no better box: a
  server failure, a rate limit whose wording we do not know, and a withdrawal that leaves
  the URL alive. The first two are refused rather than repaired, which is the part that
  matters. A fifth state exists in fact and not in the type: a permalink that does not
  answer is recorded as `drift` with `healable: false` and evidence saying the missing
  records could not be established either way. The decision is right and the label is
  wrong, and renaming the cause would touch more than it is worth this week.
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
- Coverage is two recall sources and two marketplaces, and only two of the four are
  real: one regulator and one marketplace. A recall we hold can be listed somewhere we
  do not watch, and this feed cannot see that.

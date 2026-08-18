# Decisions

Short record of the choices that shaped this project, and what forced them. Written
as we went, not reconstructed afterwards.

## 1. Detect and repair is not the differentiator

"An LLM rewrites broken selectors" is a solved and crowded problem as of 2026:
[anansi](https://github.com/mdowis/anansi) ships four repair strategies and an MCP
server, [scry](https://github.com/mayflower/scry) retries up to twenty times, Kadoa
sells it commercially, and there are step-by-step tutorials for the whole loop. A
submission whose novelty is the repair loop is competing against prior art a judge
finds in one search.

So the repair loop is table stakes here, not the contribution.

## 2. The contribution is deciding whether to repair at all

When a field goes null there are four causes, and two of them must never be repaired.

| Cause | Correct action |
| --- | --- |
| Layout drift | heal |
| Pagination change | heal |
| Bot wall or rate limit | back off; healing cannot clear a block |
| The thing is genuinely gone | never heal; preserve last-good, mark it |

Every self-healing scraper we found treats all four as the first case. Point a healer
at something that has been deliberately removed and it will obediently find *some*
node to fill the gap, and publish a fabrication. In a safety context that is the one
failure that matters, so the refusal is the product.

This lives in `engine/src/classify.ts`, and `engine/src/prompt.ts` throws
`NotHealableError` rather than emitting a prompt for `blocked` or `gone`. The refusal
is enforced in code, not left to a convention someone remembers.

## 3. Verification cannot be delegated to the vendor

Measured, not assumed. Our first heal returned `status: "done"` having completed a
stage named `request_fulfillment_validator`, and the collector then extracted **zero
rows**, exactly as before the heal.

Bright Data's healer mutates and self-certifies. Only an independent check of real
output against a contract establishes whether the data is actually there. Hence the
contract layer, and hence the rule that we never *serve* output we have not verified.

Related: `bdata scraper run --version dev` is unreachable from the CLI, because the
root command's global `-v, --version` shadows the subcommand option, so `--version dev`
prints the CLI version and exits. We therefore cannot run a heal draft before it
reaches production. The gate moved from "before production changes" to "before the
data is served", which is the more important gate anyway.

## 4. Heal can rewrite the output schema, not just the selectors

After healing through a page redesign that relabelled "Batch codes" to "Affected
units", the collector renamed its own output field from `batch_codes` to
`affected_units`. A contract checking fixed key names would read a successful heal as
a total failure of that field.

Source adapters therefore accept a set of aliases per canonical field rather than one
fixed key.

## 5. Bright Data blocks Government domains, so we scrape the commercial side

The original plan was to scrape regulator recall listings. Bright Data refuses:

> `www.gov.uk` is classified as Government and blocked by Bright Data as it might
> breach Bright Data usage policy

The same denial covers `ec.europa.eu` and `recalls-rappels.canada.ca`.
`www.productsafety.gov.au` is permitted, but only because their classifier does not
tag it as Government, which is a gap rather than a guarantee and could close at any
time. Building on it would be fragile, and claiming a government-data project while
their policy blocks government data reads badly.

So the sources split by who is allowed to fetch what:

- **Recall records** come from official machine-readable feeds we fetch ourselves.
  The CPSC API is free, public, and goes back to 1973. No Bright Data involved, so no
  policy question arises.
- **Marketplace listings** are scraped with Scraper Studio. Commercial e-commerce is
  permitted (Amazon, Walmart and eBay all verified allowed) and is what the product is
  built for.

This turned out better than the original plan on every axis. Retailer markup changes
constantly, where government sites run multi-year redesign cycles, so self-healing is
justified by the real failure rate. And two classifier branches stop being theoretical:
marketplaces actively bot-block, and a delisted product page is a genuine `gone`.

## 6. The question is which recalled products are still on sale

Large retailers comply with recalls quickly. Resale marketplaces do not, because a
recall notice never reaches the secondhand market. That gap is the thing worth
publishing, and it is only visible by scraping.

## 7. What we will not publish

Recalls are frequently batch-specific, and a marketplace listing rarely shows a lot
code. It follows that a title match cannot establish that a particular listing is a
recalled unit.

Therefore:

- No individual seller identities in the public feed.
- No assertion that a listing **is** a recalled unit. We publish that a listing
  matches a recall, the confidence, and the tokens the match rests on.
- Low-confidence matches are quarantined rather than shown.

Accusing a named seller of selling recalled goods on a fuzzy title match would be
exactly the category of lie this project exists to avoid. The discipline we apply to
scraper output applies to our own inferences.

## 8. Every measurement is recorded when it is taken, not when it is needed

Mid-build our Bright Data account hit an account-wide request cap. The same
collector that had completed a full detect-classify-heal-verify cycle in 166s at
12:45Z returned `too many requests` at 16:10Z, on our own fixture, with the balance
untouched at $52.00 because throttled requests are not billed.

Unverified accounts sit in Immediate Access Mode: GET only, a pre-approved domain
list, and provider throttling. Removing it needs identity verification, which has a
48 hour SLA outside our control.

The lesson is not about one vendor's tiering. It is that a demo which can only be
produced live is one quota away from having nothing to show. Every run in `runs/`
is kept with its timing, its input URL and its raw output, written at the moment it
happened. So the 166s figure survives the cap, and it survives as a measurement
with its evidence attached rather than a number in a README.

The engine is unaffected by any of this, because every outside call goes through
`CycleDeps`. The classifier, contract and refusal logic are testable, and tested,
with no network at all.

## 9. One adapter per collector, not one per site

We assumed a collector's output shape follows the site it reads. It does not. It follows
the collector.

Three collectors over the same fixture, created from near-identical intent sentences,
returned three different shapes. One nested every row inside a `results[]` envelope; the
others were flat. One reported `price` as a number with no currency, another as
`{ value, currency, symbol }`. The permalink was `url`, then `item_url`, then
`listing_url`. The date was `listed`, then `listed_date` as a full timestamp, then
`date_listed`. The identifier was `id`, then `item_id`, then `listing_id`.

The third arrived a day after the second, from a sentence written to match, which is the
part worth noting: this is not drift over months of vendor changes. Two collectors built
the same way on consecutive days do not agree on what to call a field.

The first time we hit this we reused an adapter across two collectors, every row was
rejected, a working collector looked like a total extraction failure, and the engine
spent four minutes healing it. That is the false repair this project argues against,
produced by the project, for the most boring possible reason.

So each collector gets an adapter, each adapter accepts a set of aliases per canonical
field, and `sources/tradewell.test.ts` runs all three real captures through it and
asserts they agree on the facts, not merely that they parse. The agreement check runs
pairwise against the first capture, so adding a fourth collector extends it by one line
and cannot quietly go unchecked. Alias tolerance is not defensive padding here, it is the
thing that stops a rename from reading as a data loss.

## 10. A repair that could not start is not a repair that failed

Heal is exclusive per collector. A second call while one is running returns HTTP 409
`Another refactor job is still in progress`, and the CLI reports that as
`heal_trigger_failed` with zero completed steps.

Read literally, that is a failed repair. It is not. Nothing was attempted and the
collector is untouched. The two states call for opposite responses: escalate, versus
wait and try later. Worse, the refusal count is the number this project is judged on, and
treating a queue conflict as a refusal inflates it with something we did not decide.

So `bdata.ts` detects the 409 and returns `heal_busy`, `runCycle` records a deferral
without marking a heal attempted, and the feed labels it as waiting rather than as a
judgement. There is a test for it, because the distinction is invisible until it is wrong.

## 11. A recorded incident is never edited

Three incidents were wrong after the fact. One carried evidence wording that said
"withdrawn by the regulator" for a marketplace, written before that string was made
source-neutral. One predated the deferral flag, so the published log would have counted a
queue conflict as a refusal. One recorded a genuine deferral, but against a collector
still finishing creation, whose field naming the adapter did not yet know: it read zero
rows and called that drift. The deferral in it was real and the failure under it was
scaffolding.

None was corrected in place. The first was re-produced by re-running the whole scenario
against the live collector, and the superseded record deleted. The second and third were
deleted outright, each with its reason written to `runs/timing.log`.

The same rule applies one level out. A hand-written line in `runs/timing.log` recorded a
repair as taking 330.5s where the incident file holds 330551ms, which rounds to 330.6s.
The correction is appended, not applied to the original line. A measurement log that gets
tidied afterwards is not a measurement log.

Editing a recorded measurement to match a later understanding of it is the one thing a
project built on "we only publish what we verified" cannot do. Re-run it or drop it and
say so.

## 12. The fixture is labelled, always

We cannot ask a real marketplace to redesign itself on cue, so breakage is demonstrated
against a target we control and are permitted to break. It is labelled a synthetic test
fixture everywhere it appears, and its variants replay realistic changes rather than
inventing implausible ones. Passing a fixture off as a real site would forfeit more
credibility than the demo is worth.

## 13. A returning record outranks a risk band

The feed sorts recalls by the source's risk band. A product that was withdrawn from sale
and then relisted now sorts above all of them, whatever band it carries.

The band is the regulator's judgement about the product, made once, and every recall in
the feed has one. A return to sale is a fact about the present, it is rare, and it is the
only thing on the page that changes what a reader who came yesterday should do today.
Ranking it under a band would bury the one event that justifies checking again.

It gets weight rather than colour. Hue on this feed means what the system decided about a
record, and a relisting is not our decision, so the badge and the figure are filled in
ink instead of clay: the heaviest marks on the page, making no claim about who decided
anything. Both dates come from the incident log rather than from a flag set at render
time, so what the feed says about the record can be checked against the record of why it
says it.

## 14. An oracle that does not answer is not a licence to repair

The withdrawal oracle was status-only: a permalink counted as withdrawn if it returned
404 or 410, and anything else made the record merely lost. Lost is the verdict that
authorises a repair.

Two inputs defeated that, and an adversarial review panel found both independently.

A site can answer HTTP 200 with a "no longer available" page. Marketplaces do this
routinely for ended listings. Such a record was filed as lost, healed, and then dropped
from the baseline by the post-repair run, so a deliberately removed record was replaced
with fabricated data and left no incident behind. That is precisely the failure this
project exists to prevent, reached through a door it was not watching.

A transport failure returns status 0 by design, so a flaky network is not mistaken for a
withdrawal. Correct as far as it went, but the record then fell through to lost, and
lost heals. The safety property failed open exactly when the instrument was broken.

The asymmetry is the lesson. Block detection was body-aware from the first version, with
a list of interstitial phrases checked on a 200. Withdrawal detection was status-only.
The weaker detector was on the case the project is actually about, and it stayed there
because the fixtures return clean 404s and nothing in the test suite asked.

So the oracle now reads bodies, with a deliberately narrow list of phrases, since a false
positive here marks a live record withdrawn. And a probe that did not answer produces a
third category: not withdrawn, not lost, unresolved. Any unresolved ref stops a repair before any
repairable branch is reached, because a repair asserts the missing records are still
published and that is the assertion we just failed to establish. The incident still
carries a cause, and it says `drift`, which is the closest honest label for "something
changed and we could not check what". A reader of the log should know that an oracle
failure and a genuine layout change land under the same word. Five tests hold the
line, including the mixed case where two refs are confirmed live and one is unreachable,
which is the one a careless implementation gets wrong.

A third route was closed at the same time: a permalink that answers 200 after being
redirected somewhere else. Marketplaces send an ended listing to a category page or a
similar product, and following the redirect to a 200 made a removed record look present.
Only a changed path counts, since a scheme upgrade, a host alias and a trailing slash are
all the same page and treating those as withdrawals would mark live records gone.

What the oracle still cannot see, stated because these are the cases a reader should not
assume are handled:

- **In-place revision.** A notice whose permalink returns 200 with materially changed
  content, most importantly a recall expanded to cover more units. The record looks
  healthy and the change is invisible. This is the most common real-world event the
  classifier misses, and closing it needs content hashing per record rather than a
  liveness probe.
- **Semantic drift.** Fields that still parse while their meaning moves, a price that
  starts including shipping being the obvious one. The contract checks shape and null
  rate, not meaning.
- **A soft-gone page whose wording is not in the list.** `GONE_MARKERS` is deliberately
  narrow, because a false positive marks a live record withdrawn. Narrow means it misses
  phrasings nobody anticipated. This one is asymmetric on purpose: a missed gone-phrase
  leaves the record unresolved, which refuses the repair, so the failure is a stale cycle
  rather than a fabricated record.

The "unresolved" test is an allowlist rather than a list of bad statuses, and that was
not the first design. It began as a blocklist naming 0, 5xx, 403, 429 and 408, which are
the responses that had actually bitten us. A property test in
`engine/src/classify.fuzz.test.ts` generated a permalink answering 418 and it fell
straight through into `lost`, which is the one verdict that authorises a repair.
Enumerating known-bad cases means every response nobody thought of is read as evidence
the record is still published. Exactly one response now means "still there", a clean 200
with nothing in the body saying otherwise, and everything else refuses.

That is worth stating as a general rule rather than a bug report. Three of the four holes
in this oracle were the same mistake: deciding what counts as absence, and letting
everything else default to presence. Presence is the claim that costs something, so
presence is what has to be proven.

## 15. Verifying a repair means checking it against everything we know

The rule was that no repair is served until a fresh run has been measured against the
contract. That was not enough, and an adversarial review found the gap by writing the
test rather than arguing for it.

A cycle can hold both a withdrawal and a genuine extraction loss. One record 404s at its
own URL; another is missing while its permalink still resolves. The classifier calls that
`drift` and allows the repair, because the repair is for the record we actually lost. The
repair then returns both, the contract passes because the contract measures shape, and the
withdrawn record is served as `healed` and written back into the baseline.

That is the phantom the whole project exists to prevent, arriving through the repair path
instead of the classifier. It is not a hypothetical: an LLM healer asked to recover
missing rows produces rows, and a record that 404s is exactly the kind of thing it
reconstructs from a stale cache or an adjacent listing.

Two things were wrong and both are fixed. The post-repair check now rejects output
containing any record confirmed withdrawn in that cycle. And the last-good fallback, which
several refusal paths serve, is filtered by what we now know: last-good is a snapshot of a
moment before we learned the record was gone, and serving it unfiltered republishes the
same phantom under an "unverified" label. Stale is the point of keeping a last-good.
Stale and known wrong is not.

The uncomfortable part is where the defect came from. A property test I had written the
same afternoon explicitly permitted this case, with a comment reasoning that a withdrawn
record could not come back because it was gone from the source. The healer is the one
component in the system whose failure mode is inventing data, and I had assumed it would
not. The property now asserts the opposite, and the comment says so.

## 16. Self-evolution is allowed to fill a null and nothing else

Scraper Studio heals the collector. Nothing was maintaining the layer above it, and that
layer drifted faster than the sites did: three collectors built from near-identical
sentences over one fixture returned three different names for the same field in two days,
and each time a person edited an adapter.

Field names are therefore data, in `learned/aliases.json`, and `npm run evolve` derives
new ones from the committed captures. The question that decides whether such a thing is
an asset or a liability is what it is allowed to change without being asked.

The line is not "reversible". It is "can only fill a null, and could not plausibly be
wrong". An alias for a canonical field that is null on every row is appended, never
inserted, so it cannot alter a value the engine already reads, and it is undone by
deleting one line. Only distinctively-shaped fields qualify: an identifier whose values
are already in the baseline, a URL that parses, a date, a number.

Everything else is a proposal with its evidence. New withdrawal phrases, because a wrong
one takes a live recall off the feed. Repair prompts, because a bad prompt has wedged a
collector permanently here twice. And seller identity is off the table in both
directions at any confidence, because the evolver must not become a second door into the
one guarantee this project makes about people rather than data.

Three things went wrong while building it, all in the first dry run, and they are the
reason the rule reads the way it does. It offered to read a shipping cost as a currency,
because a text field matches any non-empty string. It offered to read our own seller hash
as a seller name. And it read the identifier `TW-33887` as a price, because the number
test stripped non-digits before parsing. Every one of those was reversible. Reversibility
bounds what a wrong change costs; it does not make the change right, and an evolver needs
both.

The evolver cannot reach `contract.ts` at all. A system that quietly retunes its own
thresholds until nothing fails would be the exact inversion of this project, and the
cheapest way to guarantee it never happens is to give it no access.

One last thing it taught us, which is the argument for having built it. Run against the
store as it stood before the third collector existed, it derives the two aliases that
were actually needed and declines the third. I had patched that third one in by hand and
never noticed it was unnecessary: the collector also returned a field the adapter already
understood, so nothing was ever null. The guard that only fills nulls caught a redundant
edit that a person made.

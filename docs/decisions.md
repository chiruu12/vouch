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

## 9. The fixture is labelled, always

We cannot ask a real marketplace to redesign itself on cue, so breakage is demonstrated
against a target we control and are permitted to break. It is labelled a synthetic test
fixture everywhere it appears, and its variants replay realistic changes rather than
inventing implausible ones. Passing a fixture off as a real site would forfeit more
credibility than the demo is worth.

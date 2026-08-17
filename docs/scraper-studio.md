# Working with Bright Data Scraper Studio

Notes from building Vouch on Scraper Studio and the `bdata` CLI (v0.3.5) over six days.
Everything here was measured rather than read in the docs, and the numbers come from
`runs/timing.log`, written at the moment each run happened.

The short version: describing a page in a sentence and getting a working collector back
five minutes later is genuinely good, and it removed the part of scraping we expected to
spend most of the week on. What it does not give you is any way to know whether the
collector is still right tomorrow. That gap is the whole reason this project has an
engine at all.

## What it does well

**Creation from an intent sentence works.** You give it a URL and a plain description
of what to pull, and it returns a collector with a generated output schema. No
selectors, no browser session, no login. Timings for a 12-record, 2-page listing:

| Operation | Time |
| --- | --- |
| `scraper create` | 128s to 306s |
| `scraper heal` | 90s and up |
| `scraper run --sync` | 5s to 6s |

**It handles a real hostile target.** eBay search results, 193 listings from one query,
about six minutes, zero error rows. An earlier query returned 169 listings in 244
seconds, also clean. That is the case we most expected to fail, and it did not need any
tuning.

**Cost at this volume is not a factor.** Account balance did not move across two
creates, three heals and seven runs. Only page loads bill. Throttled requests are not
billed either, which we found out the hard way while looking at a balance that had not
changed during a rate limit.

**The creation pipeline is legible.** The CLI streams its stage names, so a five minute
create is watchable rather than opaque:

```
prepare_intent_analyzer -> user_intent_analyzer -> planner -> discovery
-> collector_mainatiner -> output_schema_generator -> code_generator
-> input_schema_generator -> preview_runner -> preview_picker
```

## What surprised us

### Heal rewrites the output schema, not just the selectors

We healed a collector through a page redesign that had relabelled "Batch codes" to
"Affected units". The heal worked, and the collector also renamed its own output field
from `batch_codes` to `affected_units`.

This is reasonable behaviour and it breaks anything downstream that pins key names. A
contract checking fixed keys reads a successful heal as a 100% null rate on that field,
which then looks like a fresh failure and triggers another heal. Source adapters here
accept a set of aliases per canonical field for exactly this reason.

### Heal reports success without producing data

The one that shaped the whole architecture. A heal returned:

```json
{ "status": "done", "completed_steps": ["...", "request_fulfillment_validator", "..."] }
```

and the collector then extracted **zero rows**, exactly as before the heal. A stage
literally named `request_fulfillment_validator` had passed.

The healer mutates and self-certifies. Only an independent measurement of real output
against a contract establishes whether the data came back. Everything in this project
downstream of that finding follows from it: we never serve output we have not measured
ourselves.

### A heal can permanently wedge a collector

Two collectors in this account are stuck, by two different routes.

The first: a second `scraper heal` against a collector whose previous heal had
auto-approved returned HTTP 422 `Invalid message` with zero completed steps, and it has
not accepted a heal since.

The second: a heal that never produced a usable repair left the refactor lock held.
Every subsequent heal on that collector has returned the 409 below, across four attempts
over twenty minutes. The lock outlives the job that took it.

Treat a wedged collector as a real operational state, not a transient error. We keep a
standby collector against the same fixture with the same intent, because five free
minutes beforehand is cheaper than discovering it mid-demo.

### Heal is exclusive per collector, and "busy" looks exactly like "failed"

A second `scraper heal` while one is already running returns:

```
Status: 409
error: "Another refactor job is still in progress"
```

Which is correct behaviour. The problem is what the CLI puts in its own `status` field:
`heal_trigger_failed`, with `completed_steps: []`. A caller reading the status sees a
failed repair, when what actually happened is that no repair was attempted and the
collector is untouched. The two call for opposite responses: escalate, versus wait and
retry.

The CLI does say the right thing in its human-readable output, to its credit:

```
Note: the heal did not complete, but scraper c_... is unchanged and still works as
it did before.
```

We now detect the 409 and report it as `heal_busy`, a deferral rather than a failure, so
it does not land in the incident log as an attempted repair that did not work. This is
easy to get wrong, because the first time you see it you will be looking at a real
breakage and will read the status field.

### The repair prompt has undocumented limits

Angle brackets in a heal prompt produce HTTP 422 `Invalid message`. The prompt is also
hard-capped at 1000 characters, which matters when the prompt is synthesised from
evidence and the evidence is long. Our synthesiser strips brackets and budgets the
character count across evidence lines by priority.

### `--version dev` is unreachable, so drafts cannot be inspected

`scraper run --version dev` should let you run a healed draft before promoting it. From
the CLI it cannot be reached: the root command defines a global `-v, --version`, which
shadows the subcommand option, so `--version dev` prints `0.3.5` and exits.

Consequence: a heal cannot be inspected before it reaches production. `--auto-save` is
then not optional, because without it the fix lands in a draft with no way to run it.
And `scraper approve --auto-save` after the fact returns HTTP 400 `Invalid ide
automation`, so a heal cannot be saved retroactively either.

This moved our verification gate. We cannot gate what reaches the collector, so we gate
what reaches the reader: unverified output is never served as current, whatever state
the collector is in. That is arguably the more important gate, but it was not a choice.

### A failed run is a normal event and must not throw

Against an anti-bot interstitial, the sync endpoint times out server-side after about
50 seconds and the CLI exits non-zero. Letting that exception propagate killed our cycle
*before* the classifier could label it `blocked`, which lost a refusal path at the exact
moment it mattered. A failed run is now data: zero rows plus the error, handed to the
classifier like any other result.

### The output envelope is a property of the collector, not the site

One collector returns listing fields at the top level. Another, over the same site,
nests them inside a `results[]` array. We reused an adapter across two collectors on
that assumption and every row was rejected, so a working collector looked like a total
extraction failure and the engine spent four minutes healing it. One adapter per
collector, verified against a real capture.

### Immediate Access Mode is invisible until it bites

Before identity verification an account sits in Immediate Access Mode: GET only, a
pre-approved domain list of roughly 200 sites, and provider throttling. Nothing
announces this. The same collector that completed a full detect-classify-heal-verify
cycle in 166s at 12:45Z returned `too many requests` at 16:10Z on our own fixture, with
the balance untouched at $52.00.

Our first hypothesis was that the block was domain-specific. It was not, and we spent
eight Web Unlocker probes establishing something one request would have shown. Limits
recalculate roughly every 15 minutes; verification has a 48 hour SLA and cleared in
under a day.

If you are building anything time-boxed on this, verify the account on day one.

### Government domains are blocked by classifier

```
www.gov.uk is classified as Government and blocked by Bright Data as it might
breach Bright Data usage policy
```

The same denial covers `ec.europa.eu` and `recalls-rappels.canada.ca`.
`www.productsafety.gov.au` is permitted, but only because their classifier does not tag
it as Government, which is a gap rather than a guarantee.

This killed the original plan of scraping regulator recall listings and pushed the
project onto official recall APIs for the record side and Scraper Studio for the
commercial side. It turned out better: retailer markup changes constantly where
government sites run multi-year redesign cycles, so self-healing is justified by a real
failure rate rather than a hypothetical one.

## What we would want next

1. **A reachable draft run.** `--version dev` working from the CLI would let the
   verification gate sit before promotion instead of before serving. This is the single
   change that would most improve the tool for anything production-facing.
2. **A schema stability signal on heal.** The heal response knows it renamed
   `batch_codes` to `affected_units`. Returning that mapping would let a consumer
   migrate instead of guessing at aliases.
3. **A way to un-wedge a collector**, or a clearer error than HTTP 422 `Invalid message`
   with zero completed steps.
4. **Account mode surfaced in responses.** A field saying "this account is in Immediate
   Access Mode, this domain is not on the list" would have saved us an afternoon.

## What we built on top

None of the above is a complaint about the healer. Repairing a broken selector with an
LLM is table stakes in 2026 and Scraper Studio does it well. The gap is that a healer
cannot tell the difference between a page that changed and a record that was deliberately
removed, and will confidently repair both.

So the engine sits above it and decides whether to call `heal` at all:

- a contract per source, with per-field null rates and type checks calibrated against an
  observed healthy capture, plus a row-count cliff
- a four-way classifier, where `blocked` and `gone` are never repaired
- the record's own permalink as the withdrawal oracle, because a 404 on the record's
  page is unambiguous where its absence from a listing is not
- a repair prompt synthesised from the measured evidence, and a synthesiser that throws
  rather than emit a prompt for an unrepairable cause
- a re-run and re-measurement after every repair, because the vendor's "done" is not
  evidence

The result is a system where a delisted product stays delisted instead of being invented
back into a safety feed.

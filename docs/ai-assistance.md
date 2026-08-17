# AI assistance

Required disclosure for the WeMakeDevs "Into the Scrape-Verse" hackathon, and worth
writing carefully regardless.

## The short answer

This project was built by one person over six days using Claude Code as a coding
assistant throughout. Most of the code in this repository was drafted with AI
assistance and then reviewed, corrected and directed by me. The architecture, the
central argument, and every call about what the system is allowed to claim are mine.

## What was AI-assisted

- **Implementation.** The TypeScript in `engine/` and `web/` was largely drafted with
  Claude Code, working from a design I specified, and revised through review.
- **The fixture markup.** `fixtures/*/build.mjs` generates the synthetic sites and
  their variants. The generators were written with assistance; the product data in
  `data.json` was chosen by hand so the fixtures mirror real recalled products.
- **Tests.** The 83 tests were written with assistance. Several caught real bugs, and
  where they did the fix is described in the file the bug lived in.
- **Prose.** These documents and the README were drafted with assistance and edited by
  me.

## What was not

- **The idea.** Refusing to repair is the contribution, and the four-cause taxonomy
  that makes the refusal decidable came out of reading how existing self-healing
  scrapers behave.
- **The measurements.** Every number in the README, in `docs/scraper-studio.md`, and on
  the feed came from a real run against a real Bright Data collector, written to
  `runs/timing.log` at the moment it happened. Nothing is estimated, extrapolated, or
  reconstructed after the fact.
- **The findings about Scraper Studio.** The heal-renames-your-schema behaviour, the
  heal that reported `done` and returned zero rows, the wedged collector, the
  unreachable `--version dev`, the Immediate Access Mode cap: all observed, all
  reproducible from the logs in `runs/`.
- **The demo.** No fabricated runs and no faked timings. Where the video is sped up it
  is labelled, and the mean time to repair shown is the measured one.

## Where AI got it wrong

Recording these because a disclosure that only lists successes is not a disclosure.

- An adapter was reused across two collectors on the assumption that the output shape
  follows the site. It follows the collector. Every row was rejected, a working
  collector looked broken, and the engine spent four minutes healing it. That incident
  is on the published incident log rather than deleted.
- A contract was wired to compare its own canonical field names against the collector's
  raw ones, so every field read as 100% null and a healthy scraper was repaired for no
  reason. This is precisely the false repair the project argues against, produced by
  the project.
- An early matcher run returned zero publishable matches out of 169 real listings. The
  fault was the experiment design, not the matcher: the search queries were hand-picked
  rather than derived from the recalls they were meant to match.
- A seller-name scrubber handled the top-level field and missed the same field nested
  one level down. It would have reported success while publishing 14 names.

Each of these was caught by a gate or a test rather than by inspection, which is the
argument for having them.

## Models used

Claude (Opus and Sonnet) via Claude Code, for code, tests and prose. Bright Data
Scraper Studio's own LLM generates and repairs the collectors, which is the subject of
the project rather than an assistance disclosure.

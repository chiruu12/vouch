# AI assistance

Required by the WeMakeDevs "Into the Scrape-Verse" rules: "AI coding assistants are
allowed, but their use must be disclosed." The rules also say a participant must
understand the submitted code and be able to explain it, so this document is written to
be checkable rather than to be sufficient. Ask me about any file in the repository.

It would exist anyway. A project whose argument is that you should not publish what you
have not verified would look ridiculous being vague about how it was built.

## The short answer

This project was built by one person during the hackathon week using Claude Code as a
coding assistant throughout. The git history spans 67 hours and 99 commits,
which is what `git log` reports. Two earlier drafts of this line were wrong in opposite
directions, first six days and then about one, and a review caught it both times rather
than the author. A project that asks to be judged on its numbers should not need telling
twice about its own. Most of the code in this repository was drafted with AI
assistance and then reviewed, corrected and directed by me. The architecture, the
central argument, and every call about what the system is allowed to claim are mine.

## What was AI-assisted

- **Implementation.** The TypeScript in `engine/` and `web/` was largely drafted with
  Claude Code, working from a design I specified, and revised through review.
- **The fixture markup.** `fixtures/*/build.mjs` generates the synthetic sites and
  their variants. The generators were written with assistance; the product data in
  `fixtures/*/data.json` was chosen by hand so the fixtures mirror real recalled products.
- **Tests.** The 348 tests were written with assistance. Several caught real bugs, and
  where they did the fix is described in the file the bug lived in.
- **The visual design.** The feed was redesigned by Kimi K3 running headless in an
  isolated git worktree, briefed on the constraints and given no access to the branch it
  would be merged into. Its diagnosis was better than the design it replaced: refusals
  had been rendered in the visual vocabulary of errors, and severity used the same red,
  so a serious hazard and a decision not to publish looked alike. Separating those two
  channels, so hue means only what the system decided about a record, is its call. I
  reviewed the diff, changed the favicon, and integrated it.
- **The audit.** A second Kimi K3, read-only, audited the result and was told to attack
  the output verifier specifically. It found three ways past it. See below.
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
  raw ones, so every field read as null on every row and a healthy scraper was repaired
  for no reason. This is precisely the false repair the project argues against, produced by
  the project.
- An early matcher run returned zero publishable matches out of 169 real listings. The
  fault was the experiment design, not the matcher: the search queries were hand-picked
  rather than derived from the recalls they were meant to match.
- A seller-name scrubber handled the top-level field and missed the same field nested
  one level down. It would have reported success while publishing 14 names.
- `web/verify-output.mjs` checks that the built pages quote engine text whole. It was
  wrong four times, and each version passed a mutation it claimed to catch. Version one
  concatenated every page into one string, so a refusal intact on the incident log
  satisfied the check for the same refusal truncated on the front page. Version two
  fixed that and then held a page to a string only if the page contained the string's
  first 40 characters, so truncating the head instead of the tail dropped the page out
  of the checked set entirely. Version three stripped `<script>` tags but kept their
  contents, and a static Next export inlines every server-rendered string in the RSC
  flight payload, so a whole section could be deleted from a page and still be found in
  its own payload. Version four asked whether a page contained a string rather than how
  many times, so where one sentence renders twice, truncating one left the other to
  answer for it. The first was caught by mutation-testing my own check. The second and
  third were found by an AI audit I commissioned to attack it. The fourth was found by
  the mutation suite that audit prompted me to write.
- The mutation harness itself then produced a false result. A shell one-liner lost its
  quoting, the mutation never reached the file, the build came out clean, and the run
  reported that the verifier had a hole. A no-op mutation is indistinguishable from an
  escaped one unless the harness proves it edited something, which it now does.

Each of these was caught by a gate, a test, or a review pass rather than by inspection,
which is the argument for having them. The verifier is the sharpest case: it is the
component that enforces the project's central promise, it is the one I was most
confident in, and it was broken for longer than anything else here.

## Models used

Claude (Opus and Sonnet) via Claude Code, for code, tests and prose. Kimi K3 via a
headless fleet runner, for the visual design pass and the adversarial audit that
followed it. Bright Data Scraper Studio's own LLM generates and repairs the collectors,
which is the subject of the project rather than an assistance disclosure.

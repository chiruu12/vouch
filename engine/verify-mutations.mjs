// Do the engine's tests actually hold the safety invariants up?
//
// A test suite that passes proves the code does what the tests describe. It does not
// prove the tests describe anything that matters. The way to tell is to break each
// invariant on purpose and check the suite notices, so every mutation below removes a
// guarantee this project states in public, and the suite is required to go red.
//
// Four of these were real bugs, not hypotheticals. The prior-cycle phantom and the
// raw-HTML gone match both shipped, and both were found by other people reading this
// code. They are here so they cannot come back quietly.
//
// The same rule as the web harness, learned the same painful way: an unapplied mutation
// always passes, and looks exactly like a hole that isn't there. So each mutation
// asserts its target exists before editing and asserts the file changed after, and the
// suite refuses to conclude anything from an edit it cannot prove it made.
//
//   node verify-mutations.mjs        # all of them
//   node verify-mutations.mjs 1 4    # just those
//
// Run from engine/, on a clean tree. Reverts each mutation before the next.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTATIONS = [
  {
    name: "a withdrawn record becomes repairable",
    breaks: "the core rule: healing a record that was taken down republishes a phantom recall",
    file: "src/classify.ts",
    from: 'return { cause: "gone", withdrawnRefs, lostRefs: [], unresolvedRefs: [], healable: false, evidence };',
    to: 'return { cause: "drift", withdrawnRefs, lostRefs: [], unresolvedRefs: [], healable: true, evidence };',
  },
  {
    name: "the phantom guard forgets earlier cycles",
    breaks: "a record proved gone last cycle can be re-fabricated by an unrelated repair and served as healed",
    file: "src/runner.ts",
    from: "const phantoms = afterRefs.filter((r) => knownWithdrawn.includes(r));",
    to: "const phantoms = afterRefs.filter((r) => diagnosis.withdrawnRefs.includes(r));",
  },
  {
    name: "a repair may abandon the record it was called for",
    breaks: "a partial repair closes the incident as healed and the abandoned notice leaves the baseline",
    file: "src/runner.ts",
    from: 'const abandoned = diagnosis.lostRefs.filter((r) => !afterRefs.includes(r));',
    to: 'const abandoned = [];',
  },
  {
    name: "the abandonment refusal is downgraded to a warning",
    breaks: "the row-drop limit then ratchets: each accepted partial repair is the next one's baseline",
    file: "src/runner.ts",
    from: 'if (abandoned.length > 0) {',
    to: 'if (abandoned.length > 99) {',
  },
  {
    name: "the gone oracle reads script payloads",
    breaks: "a live listing whose page embeds the phrase in a UI string table is published as withdrawn",
    file: "src/oracles.ts",
    from: "const hay = saidOnPage(body);",
    to: "const hay = body.toLowerCase();",
  },
  {
    name: "the oracle stops normalising whitespace, so a learned phrase cannot match",
    breaks: "a marker learned from a page no longer fires on that page, and gone reads as repairable drift",
    file: "src/html.ts",
    from: "return normaliseSpacing(visibleText(html)).toLowerCase();",
    to: "return visibleText(html).toLowerCase();",
  },
  {
    name: "normalisation flattens newlines as well as spaces",
    breaks: "two elements that separately say ordinary words add up to a withdrawal phrase neither said",
    file: "src/html.ts",
    from: "return s.replace(/[^\\S\\n]+/g, \" \");",
    to: "return s.replace(/\\s+/g, \" \");",
  },
  {
    name: "the block oracle reads visible text only, like the gone oracle",
    breaks: "a wall that renders its message from script is served as an ordinary page and authorises a repair",
    file: "src/oracles.ts",
    from: "if (raw.includes(m) || said.includes(m)) return m;",
    to: "if (said.includes(m)) return m;",
  },
  {
    name: "a stale source is allowed to report that it found nothing",
    breaks: "an agent tells someone a product is not recalled on the word of a source that just lost rows",
    file: "src/context.ts",
    from: "  if (broken.length > 0) {",
    to: "  if (false) {",
  },
  {
    name: "an open block stops counting against a source",
    breaks: "a source we were refused by keeps licensing \"no recall matched\", because the rows it is still serving are the last good ones",
    file: "src/context.ts",
    from: '    const open = openBreakage(snapshot, id);',
    to: '    const open = null;',
  },
  {
    name: "a failed cycle can un-withdraw a record",
    breaks: "an extraction that keeps the ref column and loses the rest clears the withdrawal mark, and the next clean cycle serves a withdrawn recall as verified with no incident behind it",
    file: "src/runner.ts",
    from: "  const resurrectedRefs = report.passed\n    ? await confirmedLive(resurrectionCandidates, args, deps)\n    : [];",
    to: "  const resurrectedRefs = await confirmedLive(resurrectionCandidates, args, deps);",
  },
  {
    name: "a resurrection is believed on the listing alone",
    breaks: "a CDN serving a pre-withdrawal snapshot passes the contract by construction, so without the permalink re-probe a stale cache is enough to republish a recalled product as verified",
    file: "src/runner.ts",
    from: "  const resurrectedRefs = report.passed\n    ? await confirmedLive(resurrectionCandidates, args, deps)\n    : [];",
    to: "  const resurrectedRefs = report.passed ? resurrectionCandidates : [];",
  },
  {
    name: "a known-withdrawn record in the listing is served anyway",
    breaks: "a withdrawn record carried by a stale listing reaches the feed before its resurrection is confirmed",
    file: "src/runner.ts",
    from: "  const servableRows = rows.filter((r) => !knownWithdrawn.includes(args.refOf(r)));",
    to: "  const servableRows = rows;",
  },
  {
    name: "the published illustration writes its own breach sentence",
    breaks: "the agents page describes a contract failure in a grammar the contract checker cannot produce, so a reader checking it against the incident log finds nothing and cannot tell which is lying",
    file: "src/agentview.ts",
    from: "  return { breach: volumeBreach(before, after, 0.2), before, after };",
    to: '  return { breach: `row count fell ${((before - after) / before * 100).toFixed(1)}% against a baseline of ${before}, limit 20.0%`, before, after };',
  },
  {
    name: "an event's zero counts as a measured repair time",
    breaks: "a withdrawal and a resurrection close instantly and correctly, and their zeroes drag the median to 0, so the tool advises hammering a source it elsewhere says to back off from",
    file: "src/context.ts",
    from: 'const REPAIRED: readonly PubIncident["cause"][] = ["drift", "pagination"];',
    to: 'const REPAIRED: readonly PubIncident["cause"][] = ["drift", "pagination", "gone", "resurrected"];',
  },
  {
    name: "an unclosed incident is always the present tense",
    breaks: "a repair deferred because the collector was busy leaves a record nothing ever revisits, so breakage_report keeps saying work is in progress on a source vouch_report calls healthy",
    file: "src/context.ts",
    from: "  if (!source.contractPassed) return true;",
    to: "  return true;\n  if (!source.contractPassed) return true;",
  },
  {
    name: "a source blocked since its last good cycle looks resolved",
    breaks: "supersession stops checking the ordering, so a live block reads as an incident the source has been verified past, and absence stops being refused",
    file: "src/context.ts",
    from: "  return verifiedAt <= incident.openedAt;",
    to: "  return false;",
  },
  {
    name: "the block statuses forget server failure",
    breaks: "a listing endpoint down while the notice pages still serve reads as a redesign, and a healer is sent at a server that is not answering",
    file: "src/classify.ts",
    from: "const BLOCK_STATUSES = new Set([401, 403, 407, 408, 429, 451, 500, 502, 503, 504]);",
    to: "const BLOCK_STATUSES = new Set([401, 403, 407, 429, 451, 503]);",
  },
  {
    name: "a probe that never answered counts as a page that changed",
    breaks: "a timeout or a DNS failure falls through to drift, so a source we could not reach at all authorises a repair",
    file: "src/classify.ts",
    from: "const noAnswer = (status: number): boolean => status === 0;",
    to: "const noAnswer = (_status: number): boolean => false;",
  },
  {
    name: "the block oracle forgets the polite walls",
    breaks: "a rate limiter that says so in words rather than a status is read as ordinary markup, which is how a collector gets wedged repairing against a wall",
    file: "src/oracles.ts",
    from: '  "too many requests",',
    to: "",
  },
  {
    name: "a withheld record arrives with no provenance",
    breaks: "quarantined_for hands an agent a synthetic fixture recall with ref, title, confidence and reason and nothing saying it is a fixture, on the one published surface no page-level gate can see",
    file: "src/context.ts",
    // Anchored through the reason line above it: both the asserted and the quarantined
    // paths end in the same `vouch: vouchFor(r),`, and editing the wrong one of the two
    // would prove something about a different promise.
    from: "          : `below the ${PUBLISH_THRESHOLD} bar to assert`,\n      vouch: vouchFor(r),",
    to: "          : `below the ${PUBLISH_THRESHOLD} bar to assert`,",
  },
  {
    name: "the quarantine digest drops the source it came from",
    breaks: "a near-miss reads as an ordinary regulator notice because the line that names its source is gone",
    file: "src/wire.ts",
    from: "        `src=${sourceKey(x.vouch)} held=${x.reason}`",
    to: "        `held=${x.reason}`",
  },
  {
    name: "a clean miss says nothing at all in JSON",
    breaks: "vouching for absence collapses to a timestamp, so a caller cannot tell the strongest claim the feed makes from the tool having failed",
    file: "src/wire.ts",
    from: "    found: refused ? null : a.asserted.length > 0 ? null : false,",
    to: "    found: null,",
  },
  {
    name: "a refusal still carries a withheld tally in one format",
    breaks: "the same answer means different things depending on which format was asked for, and a count of held-back records sits beside a refusal as the advisory sibling the design rejects",
    file: "src/wire.ts",
    from: "    withheld: refused ? [] : a.withheld.map((w) => `${w.count}x ${w.reason}`),",
    to: "    withheld: a.withheld.map((w) => `${w.count}x ${w.reason}`),",
  },
  {
    name: "staleness stays in the margin instead of on the record",
    breaks: "a model enumerating recalls[] sees a vanilla recall, because the one key saying it is stale sits in a source block it has already read past",
    file: "src/wire.ts",
    from: "        stale: r.vouch.stale ? true : null,",
    to: "",
  },
  {
    name: "the stale qualifier trails the answer it qualifies",
    breaks: "a caller that reads one line reads a recall rather than the line saying the source behind it is not currently verified",
    file: "src/wire.ts",
    from: "    out.push(`STALE ${staleSources.size} of ${total} source(s) not currently verified`);",
    to: "",
  },
  {
    // The rule moved. It was `cpscTrust` in snapshot.ts, written for the one source that
    // had a committed fallback; adding a second real source with the same shape made it
    // general, so it is `supervisedTrust` in trust.ts now and `cpscTrust` calls it. The
    // mutation moved with it rather than being dropped, which is the whole point of the
    // harness exiting 2 on a stale target instead of skipping quietly.
    name: "a captured sample is stamped verified again",
    breaks: "the one real regulator in the feed becomes the one source deriveTrust never sees, and rows nobody probed license the sentence \"no recall matched and this feed can currently say so\"",
    file: "src/trust.ts",
    from: '  if (state === null || state.lastGoodRows.length === 0) return "unverified";',
    to: "",
  },
  {
    name: "a source with no collector is sent to the healer anyway",
    breaks: "a repair budget is spent rewriting selectors on a source that has none, and whatever comes back is then measured as though it meant something",
    file: "src/prompt.ts",
    from: "  if (args.repairable === false) {",
    to: "  if (false) {",
  },
  {
    name: "the study reads the live catalogue",
    breaks: "the number the README quotes changes on every cycle, so the documented figure is wrong more often than right and nobody can reproduce it",
    file: "src/snapshot.ts",
    from: "  const study = buildStudy(studyRecalls, normaliseEbay(",
    to: "  const study = buildStudy(cpscRecalls, normaliseEbay(",
  },
  {
    name: "a withdrawal counts as breakage",
    breaks: "the service refuses to answer every time a notice is withdrawn, which is an ordinary event and not a failure",
    file: "src/context.ts",
    from: 'const BREAKAGE: readonly IncidentCause[] = ["drift", "pagination", "blocked"];',
    to: 'const BREAKAGE: readonly IncidentCause[] = ["drift", "pagination", "blocked", "gone"];',
  },
  {
    name: "the page oracle stops decoding numeric entities",
    breaks: "a withdrawal written with &#160; instead of &nbsp; reads as merely missing, and missing is what authorises a repair",
    file: "src/html.ts",
    from: '    .replace(/&#(\\d+);/g, (m, d: string) => codePoint(Number(d), m))',
    to: '',
  },
  {
    name: "a tool answers before the client has been told what it is reading",
    breaks: "an asserted recall reaches a caller that never received the product-line caveat, and reads as a claim about the unit",
    file: "src/mcp.ts",
    from: "      if (!handshaken) {",
    to: "      if (false) {",
  },
  {
    name: "health is vacuously true when there are no sources",
    breaks: "a build that lost every source reports perfect health to a caller with no reason to look further",
    file: "src/context.ts",
    from: "    healthy: sources.length > 0 && sources.every((x) => x.cause === null && CURRENT.includes(x.state)),",
    to: "    healthy: sources.every((x) => x.cause === null && CURRENT.includes(x.state)),",
  },
  {
    name: "a healthy copy of a source answers for a broken one",
    breaks: "a duplicated source id is judged on whichever row comes first in the snapshot",
    file: "src/context.ts",
    from: "    const s = rows.find((x) => !CURRENT.includes(x.trust)) ?? rows[0]!;",
    to: "    const s = rows[0]!;",
  },
  {
    name: "the runner's generator stops producing blocks",
    breaks: "the sequence properties keep passing while never visiting a branch they constrain, which is a green suite that checked nothing",
    file: "src/runner.fuzz.test.ts",
    from: "    blocked: r() < 0.15,",
    to: "    blocked: false,",
  },
  {
    name: "the matcher stops folding accents to their base letter",
    breaks: "an accented brand matches nothing and the caller is told no recall matched, which is a false absence",
    file: "src/match.ts",
    from: '  return s.normalize("NFKD").replace(/\\p{M}/gu, "").toLowerCase();',
    to: '  return s.toLowerCase();',
  },
  {
    name: "the evolver gains access to the contract module",
    breaks: "the one boundary evolve.ts claims for itself, that nothing which learns can loosen the gate it is judged by",
    file: "src/evolve.ts",
    from: 'import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";',
    to: 'import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";\nimport { checkContract } from "./contract.js";',
  },
  {
    name: "the vouch check walks the snapshot instead of the declared source list",
    breaks: "a recall source missing from the build stops being checked exactly when it matters",
    file: "src/context.ts",
    from: "  for (const id of RECALL_SOURCES) {",
    to: "  for (const id of snapshot.sources.map((x) => x.id)) {",
  },
  {
    name: "a stale hit is withheld along with everything else stale",
    breaks: "a real recall is hidden from the person about to buy the product, to keep a rule tidy",
    file: "src/context.ts",
    from: "  if (asserted.length > 0) {",
    to: "  if (asserted.length > 0 && broken.length === 0) {",
  },
  {
    name: "the refusal is printed under the answer instead of leading it",
    breaks: "the one line that stops a caller inventing an answer sits below everything it could quote",
    file: "src/wire.ts",
    from: "    out.push(`REFUSED ${a.refusalCode}`);\n    if (a.refusal !== null) out.push(a.refusal);",
    to: "    if (a.refusal !== null) out.push(a.refusal);\n    out.push(`REFUSED ${a.refusalCode}`);",
  },
  {
    name: "a withdrawal is reported as something to retry",
    breaks: "an agent waits and calls again for records the publisher deliberately took down",
    file: "src/context.ts",
    from: '  if (cause === "gone") {',
    to: "  if (false) {",
  },
  {
    name: "compaction drops the synthetic-fixture label",
    breaks: "a fixture built to induce failures is served to an agent as a real recall notice, now on both the asserted and the quarantined digest since they share one source renderer",
    file: "src/wire.ts",
    from: "    if (v.synthetic) bits.push(\"SYNTHETIC FIXTURE\");",
    to: "    if (false) bits.push(\"SYNTHETIC FIXTURE\");",
  },
  {
    name: "a refusal is emitted without a code to branch on",
    breaks: "a caller has to match the refusal by substring, which breaks the first time the wording improves",
    file: "src/context.ts",
    from: '      refusalCode: "absence_unverifiable",',
    to: "      refusalCode: null,",
  },
  {
    name: "a published link may downgrade to http on the same host",
    breaks: "a reader is handed an unencrypted link under a label saying we verified where it goes",
    file: "src/trust.ts",
    from: 'if (source.protocol === "https:" && link.protocol === "http:") return null;',
    to: "if (false) return null;",
  },
  {
    name: "the fallback serves records known to be withdrawn",
    breaks: "a refused cycle republishes a record we already proved was taken down, labelled unverified",
    file: "src/runner.ts",
    // Anchored on the whole binding rather than the bare predicate. The same filter now
    // guards this cycle's own extraction (`servableRows`), so the predicate alone matches
    // twice and a mutation that edits the wrong one of the two proves nothing.
    from: "  const servableLastGood = state.lastGoodRows.filter(\n    (r) => !knownWithdrawn.includes(args.refOf(r))\n  );",
    to: "  const servableLastGood = state.lastGoodRows;",
  },
  {
    name: "unresolved permalinks count as still published",
    breaks: "the allowlist that keeps a blocked or unreachable probe from authorising a repair",
    file: "src/classify.ts",
    from: "return !(p.status === 200 && (p.goneSignature ?? null) === null);",
    to: "return p.status === 404 || p.status === 410;",
  },
  {
    name: "the proxy's own failure counts as the site's answer",
    breaks: "a Bright Data navigation timeout becomes evidence about whether a record exists",
    file: "src/bdata.ts",
    from: "if (brdError(env.headers) !== null) return null;",
    to: "if (false) return null;",
  },
  {
    name: "the evolver may learn into the seller field",
    breaks: "the one guarantee this project makes about people rather than data",
    file: "src/evolve.ts",
    from: 'const NEVER_LEARN_INTO = new Set(["seller"]);',
    to: "const NEVER_LEARN_INTO = new Set([]);",
  },
  {
    name: "a learned withdrawal phrase applies itself",
    breaks: "the rule that a change which can remove live recalls from the feed waits for a person",
    file: "src/learn/policy.ts",
    from: `      return {
        unattended: false,
        because: "a wrong withdrawal phrase removes live recalls from the feed, so a person reads the evidence",
      };`,
    to: `      return {
        unattended: true,
        because: "a wrong withdrawal phrase removes live recalls from the feed, so a person reads the evidence",
      };`,
  },
  {
    name: "records are labelled verified regardless of trust",
    breaks: "the feed's health strip and its records can disagree during a degraded cycle",
    file: "src/trust.ts",
    from: 'if (!(report.passed || explainedByWithdrawal)) return "unverified";',
    to: 'if (false) return "unverified";',
  },
  {
    name: "a scraped permalink is published unchecked",
    breaks: "a lookalike host is rendered as a trusted link under a verified pill",
    file: "src/trust.ts",
    from: "if (link.host !== source.host) return null;",
    to: "if (false) return null;",
  },
  {
    name: "a disproved withdrawal phrase is kept",
    breaks: "the supervisor's only unattended change to its own oracle, which is the safe direction",
    file: "src/learn/markers.ts",
    from: "      out.push({ marker: l.marker, source: l.source, disprovedBy: live[0] ?? \"unknown\" });",
    to: "      void live;",
  },
  {
    name: "a retracted phrase stays active",
    breaks: "a retraction can be undone by an edit that forgets to remove the learned entry too",
    file: "src/learn/markers.ts",
    from: "    .filter((l) => l.source === source && !dead.has(l.marker))",
    to: "    .filter((l) => l.source === source)",
  },
  {
    name: "a withdrawal phrase learned on one site applies everywhere",
    breaks: "the scoping that keeps eBay's 404 chrome from marking a regulator's live recall withdrawn",
    file: "src/learn/markers.ts",
    from: "    .filter((l) => l.source === source && !dead.has(l.marker))",
    to: "    .filter((l) => !dead.has(l.marker))",
  },
  {
    name: "a blocked source is hammered instead of left alone",
    breaks: "backoff: the cycle keeps paying for a request the source has already refused",
    file: "src/runner.ts",
    from: "  const waiting = coolingDown(state.cooldownUntil, deps.now());",
    to: "  const waiting = null as number | null;",
  },
  {
    name: "a withdrawal puts the feed into backoff",
    breaks: "the rule that a source working correctly is never throttled for it",
    file: "src/backoff.ts",
    from: 'if (cause === "healthy" || cause === "resurrected" || cause === "gone") return null;',
    to: 'if (cause === "healthy" || cause === "resurrected") return null;',
  },
  {
    name: "a repair that keeps failing is retried forever",
    breaks: "the repair budget, so the same prompt goes to the same collector at cost with no new information",
    file: "src/runner.ts",
    from: "  if (repairExhausted(state.streak, diagnosis.cause) && streak !== null) {",
    to: "  if (false && streak !== null) {",
  },
  {
    name: "a repair that never ran is charged to the budget",
    breaks: "the distinction between a repair that failed and one that was never attempted",
    file: "src/runner.ts",
    from: "      nextState: carried({ streak: state.streak }),\n    };\n  }\n\n  // A call that never reached the collector",
    to: "      nextState: carried(),\n    };\n  }\n\n  // A call that never reached the collector",
  },
  {
    name: "one withdrawal excuses a drop of any size",
    breaks: "the check that withdrawals actually account for missing rows, so silent extraction loss reads as verified",
    file: "src/trust.ts",
    from: "    volumeOnly && shortfall > 0 && shortfall <= (state?.withdrawnRefs.length ?? 0);",
    to: "    volumeOnly && (state?.withdrawnRefs.length ?? 0) > 0;",
  },
  {
    name: "the collector-block pattern forgets half the refusal statuses",
    breaks: "the consistency between what the probe calls a refusal and what the collector's error may say",
    file: "src/classify.ts",
    from: 'const BLOCK_STATUS_PATTERN = new RegExp(`(?<![0-9])(${[...BLOCK_STATUSES].join("|")})(?![0-9])`);',
    to: 'const BLOCK_STATUS_PATTERN = /(?<![0-9])(403|407|429)(?![0-9])/;',
  },
  {
    name: "a block discards a withdrawal already established",
    breaks: "a 404 the oracle saw plainly is thrown away, so a withdrawn recall keeps being served as active",
    file: "src/classify.ts",
    from: "      cause: \"blocked\",\n      withdrawnRefs,",
    to: "      cause: \"blocked\",\n      withdrawnRefs: [],",
  },
  {
    name: "the marker store trusts whatever parsed",
    breaks: "an empty-string marker reads every page as withdrawn, and a wrong-shape file crashes the cycle",
    file: "src/learn/markers.ts",
    from: "    return sanitiseMarkerStore(JSON.parse(readFileSync(path, \"utf8\")));",
    to: "    return JSON.parse(readFileSync(path, \"utf8\")) as MarkerStore;",
  },
  {
    name: "a phrase too short to mean anything is accepted",
    breaks: "the floor under a learned marker, below which one phrase empties the feed",
    file: "src/learn/markers.ts",
    from: "  if (!usableMarker(m.marker)) return store;",
    to: "  if (false) return store;",
  },
  {
    name: "a learned alias is written where nothing reads it",
    breaks: "the only unattended change in the system, which would report an adaptation it did not make",
    file: "src/aliases.ts",
    from: 'export const ALIAS_DRIVEN_SOURCES: ReadonlySet<string> = new Set(["tradewell"]);',
    to: 'export const ALIAS_DRIVEN_SOURCES: ReadonlySet<string> = new Set(["tradewell", "arcadia", "ebay"]);',
  },
  {
    name: "a block only the collector saw is healed",
    breaks: "the flagship refusal, whenever the wall is on the scraper's path and not the operator's",
    file: "src/classify.ts",
    from: "const sourceSideBlock = blockedAtSource(input.extractionErrors ?? []);",
    to: "const sourceSideBlock = null;",
  },
  {
    // This one has a history. A review agent applied exactly this swap to the working
    // tree and left it there, so it was briefly the real state of the code: every
    // published listing was a Tradewell fixture wearing eBay's provenance. The test that
    // compared a listing's provenance to the card that provenance NAMES passed the whole
    // time, because that comparison is self-consistent by construction. What caught it
    // was checking the label against the permalink's host, which is the one field on a
    // published listing that does not come from the provenance.
    name: "a marketplace listing wears the other marketplace's provenance",
    breaks: "promise E in both directions: a real listing published as a fixture, and a fixture as real",
    file: "src/snapshot.ts",
    from:
      '      { sourceId: "tradewell", state: twState, contract: TRADEWELL_CONTRACT, listings: twLive },\n' +
      '      { sourceId: "ebay", state: ebayState, contract: EBAY_CONTRACT, listings: ebayRows },',
    to:
      '      { sourceId: "tradewell", state: twState, contract: TRADEWELL_CONTRACT, listings: ebayRows },\n' +
      '      { sourceId: "ebay", state: ebayState, contract: EBAY_CONTRACT, listings: twLive },',
  },
  {
    name: "a confirmed withdrawal reaches the publish boundary",
    breaks: "the second lock on a phantom: a record proved gone republished as on sale",
    file: "src/snapshot.ts",
    from: "  return (state.lastGoodRows as unknown as Listing[]).filter((l) => !withdrawn.has(String(l.id)));",
    to: "  return state.lastGoodRows as unknown as Listing[];",
  },
  {
    name: "a marketplace falls back to a capture nobody probed",
    breaks: "193 actionable claims about real sellers' pages, sourced from a file that never passed a cycle",
    file: "src/snapshot.ts",
    from: "  const ebayRows = vouchedListings(ebayState);",
    // Unconditional on purpose. The original only fell back when lastGoodRows was
    // empty, so the moment eBay passed a real cycle the edit applied and changed
    // nothing, and an inert mutation passes for the same reason an unapplied one does.
    to: '  const ebayRows = normaliseEbay(load("engine/samples/ebay-cooluli-minifridge.json")) as unknown as Listing[];',
  },
  {
    // The most expensive bug this project has had, and it was found by running against a
    // real site rather than by reading the code. Two paid repairs against a collector
    // that was working perfectly, because a scrape killed by our own timeout looks
    // exactly like a page whose shape moved.
    name: "an extraction that never finished is repaired anyway",
    breaks: "the rule that unknown is not evidence, on the extraction path: it authorises a repair against a working collector",
    file: "src/classify.ts",
    from: "  if (report.rows === 0 && unfinished.length > 0) {",
    to: "  if (false) {",
  },
  {
    name: "the location limit goes back to measuring the marketplace",
    breaks: "a deep crawl of an ordinary query, by refusing it and paying to repair a field nothing broke",
    file: "src/sources/ebay.ts",
    from: '    location: { type: "string", maxNullRate: 0.1, minLength: 3 },',
    to: '    location: { type: "string", maxNullRate: 0.05, minLength: 3 },',
  },
  {
    name: "a dead scrape still reports which records went missing",
    breaks: "the inference a repair rests on, by taking it from a listing nothing actually read",
    file: "src/classify.ts",
    from: '    return { cause: "drift", withdrawnRefs, lostRefs: [], unresolvedRefs: [], healable: false, evidence };',
    to: '    return { cause: "drift", withdrawnRefs, lostRefs, unresolvedRefs: [], healable: false, evidence };',
  },
  {
    name: "a scrape is killed before the vendor can finish it",
    breaks: "every source large enough to go to batch mode, by turning its healthy runs into false drift",
    file: "src/bdata.ts",
    from: "export const SCRAPE_TIMEOUT_MS = 900_000;",
    to: "export const SCRAPE_TIMEOUT_MS = 120_000;",
  },
  {
    name: "classifier evidence measures a null rate over an empty denominator",
    breaks: "the incident page, by publishing seven rates over no rows in front of the line that explains it",
    file: "src/classify.ts",
    from: "  for (const f of report.rows === 0 ? [] : report.fields.filter((f) => f.breached)) {",
    to: "  for (const f of report.fields.filter((f) => f.breached)) {",
  },
  {
    name: "a null rate is reported over an empty denominator",
    breaks: "the agent-facing surface, by burying the sentence that says what happened under seven that do not",
    file: "src/contract.ts",
    from: "    if (n > 0 && nullRate > rule.maxNullRate) {",
    to: "    if (nullRate > rule.maxNullRate) {",
  },
  {
    name: "vouch_report unrolls every breach onto a source line",
    breaks: "the cheap answer to what is trustworthy, by making it cost more the worse one source broke",
    file: "src/mcp.ts",
    from: "  const more = rest.length === 0 ? \"\" : ` (+${rest.length} more, call breakage_report)`;",
    to: "  const more = rest.length === 0 ? \"\" : `; ${rest.join(\"; \")}`;",
  },
  {
    name: "a withdrawal on one source explains a return on another",
    breaks: "a published back-on-sale date drawn from a site the listing was never on",
    file: "src/snapshot.ts",
    from: "        (j) => j.sourceId === i.sourceId && j.withdrawnRefs.includes(ref) && j.openedAt <= i.openedAt",
    to: "        (j) => j.withdrawnRefs.includes(ref) && j.openedAt <= i.openedAt",
  },
  {
    name: "a source with no collector is repaired anyway",
    breaks: "the refusal CPSC exists to demonstrate: a heal prompt sent at a collector that does not exist",
    file: "src/cycle.ts",
    from: "    repairable: false,",
    to: "    repairable: true,",
  },
  {
    name: "the eBay adapter derives a seller key again",
    breaks: "seller re-identification: an unsalted hash of an enumerable public username is identity, not anonymity, and the recorded state is committed to a public repo",
    file: "src/sources/ebay.ts",
    from: "    listedOn: null,\n  };\n  return listing;",
    to: "    listedOn: null,\n  };\n  const sn = blankToNull(row.seller_name);\n  if (sn !== null) listing.sellerKey = \"sk_\" + sn.trim().toLowerCase();\n  return listing;",
  },
];

/** How many tests fail, or null if the suite passed. The count is the useful part: a
 *  mutation caught by one test is held up by one test. */
function failuresUnderTest() {
  try {
    execFileSync("npm", ["test"], { stdio: "pipe", encoding: "utf8" });
    return null;
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const m = /^# fail (\d+)$/m.exec(out) ?? /fail (\d+)/.exec(out);
    return m === null ? 0 : Number(m[1]);
  }
}

const argv = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const chosen = argv.length > 0 ? argv : MUTATIONS.map((_, i) => i + 1);

// A `finally` does not run when the process is killed, and this harness spends most of
// its wall time with a safety invariant deleted from a tracked file. A Ctrl+C at the
// wrong moment left `NEVER_LEARN_INTO` emptied in the working tree: the lock that keeps
// the learner away from seller fields, removed, silently, in a file that still looked
// like the committed one at a glance. Whatever happens to this process, the tree it was
// handed goes back.
let inFlight = null;
function restoreInFlight() {
  if (inFlight === null) return;
  writeFileSync(inFlight.file, inFlight.before);
  inFlight = null;
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restoreInFlight();
    console.error(`\n${sig}: restored ${"the mutated file"} before exiting.`);
    process.exit(130);
  });
}
process.on("uncaughtException", (err) => {
  restoreInFlight();
  throw err;
});

const results = [];
for (const n of chosen) {
  const m = MUTATIONS[n - 1];
  if (m === undefined) {
    console.error(`no mutation ${n}. There are ${MUTATIONS.length}.`);
    process.exit(2);
  }

  const before = readFileSync(m.file, "utf8");

  // A mutation is only evidence if it edits what it names. This guard exists because one
  // did not: escaping collapsed a `from` string to "0", which occurs all over the file, so
  // `includes` passed, the replace landed inside an unrelated comment, the suite stayed
  // green, and the harness reported a hole in the tests that was not there. A target has to
  // be long enough to be deliberate and to appear exactly once.
  const occurrences = before.split(m.from).length - 1;
  if (m.from.length < 20 || occurrences > 1) {
    console.error(`\nmutation ${n} (${m.name})`);
    console.error(
      m.from.length < 20
        ? `  TARGET TOO SHORT: ${JSON.stringify(m.from)} is not a deliberate anchor.`
        : `  TARGET NOT UNIQUE: appears ${occurrences} times in ${m.file}.`
    );
    console.error("  A mutation that edits the wrong place proves nothing either way.");
    process.exit(2);
  }

  if (!before.includes(m.from)) {
    console.error(`\nmutation ${n} (${m.name})`);
    console.error(`  STALE: ${m.file} no longer contains the target text.`);
    console.error(`  looked for: ${JSON.stringify(m.from.slice(0, 90))}`);
    console.error(`  Fix the mutation, do not skip it: an unapplied mutation always passes.`);
    process.exit(2);
  }

  const after = before.replace(m.from, m.to);
  if (after === before) {
    console.error(`\nmutation ${n}: replace was a no-op. Refusing to draw a conclusion.`);
    process.exit(2);
  }

  inFlight = { file: m.file, before };
  writeFileSync(m.file, after);
  let failures;
  try {
    failures = failuresUnderTest();
  } finally {
    restoreInFlight();
  }

  const caught = failures !== null && failures > 0;
  results.push({ n, m, failures, caught });
  console.log(
    `${caught ? "caught " : "ESCAPED"}  ${n}. ${m.name}` +
      (caught ? `  (${failures} test${failures === 1 ? "" : "s"} fail)` : "")
  );
}

const escaped = results.filter((r) => !r.caught);
console.log("");
for (const r of escaped) {
  console.log(`ESCAPED  ${r.n}. ${r.m.name}`);
  console.log(`         breaks: ${r.m.breaks}`);
  console.log(`         the suite did not notice. That is a hole, not a pass.`);
}
console.log(`${results.length - escaped.length}/${results.length} mutations caught`);
process.exit(escaped.length === 0 ? 0 : 1);

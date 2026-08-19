// The two questions we ask a page body, and the reason they are not asked the same way.
//
// Both oracles read a page and return a phrase or null. They sit together because the
// interesting thing about them is not either one on its own, it is that they are
// mirror images and their mistakes cost opposite amounts. Keeping them in one file is
// what stops a fix landing on one and not the other, which is exactly what had happened:
// `detectGone` was moved onto visible text after a live eBay listing was nearly retired
// by a marker hiding in a script payload, and `detectBlock` was left reading raw HTML.
//
//   detectGone   says a record is withdrawn. Being wrong removes a live safety recall
//                from the feed, silently. Kept NARROW: visible text only, so a page is
//                judged on what it says and never on the string tables it carries.
//
//   detectBlock  says we were served a wall. Being wrong costs freshness: we refuse to
//                repair, serve last-good as unverified and wait out a cooldown. Missing
//                one is what is actually expensive, because an undetected wall reads as
//                records merely missing, and that authorises a repair against a wall.
//                Kept WIDE: raw body and visible text both.
//
// Both match against text normalised by `saidOnPage`, which is also what the phrase
// learner extracts candidates with. When those were two different treatments of
// whitespace, a learned phrase could not match the page it was learned from.

import { normaliseSpacing, saidOnPage } from "./html.js";
import { activeMarkersCached } from "./learn/markers.js";

/** Signatures that mean "we were served a wall, not the page". Checked on a 200,
 *  because the dangerous block is the one that does not announce itself with a 4xx.
 *  Our own blocked fixture returns 200 with an interstitial for exactly this reason. */
export const BLOCK_MARKERS = [
  "verify you are a human",
  "are you a robot",
  "unusual traffic",
  "access denied",
  "enable javascript and cookies",
  "checking your browser",
];

/** A block is checked against the raw body AND the visible text, and the asymmetry with
 *  `detectGone` is deliberate rather than an oversight left in one of them.
 *
 *  The two oracles fail in opposite directions, so they get opposite treatments. Calling
 *  a live record withdrawn removes a safety recall from the feed, so `detectGone` reads
 *  visible text only and never the script payloads a page merely carries. Calling a good
 *  page a wall costs freshness: we refuse to repair, serve last-good as unverified, and
 *  wait out a cooldown. Nothing is published that should not be.
 *
 *  Missing a block is what is actually expensive. An undetected wall comes back as rows
 *  we cannot parse whose permalinks also answer 200 with an interstitial, which reads as
 *  records merely missing, which authorises a repair. Repairing against a wall is how a
 *  collector gets wedged, and it has happened twice on this project. Plenty of anti-bot
 *  pages keep their only human-readable sentence inside a script, so visible text alone
 *  would stop seeing them. Both, then: over-eager here is the cheap mistake. */
export function detectBlock(body: string): string | null {
  const raw = normaliseSpacing(body).toLowerCase();
  const said = saidOnPage(body);
  for (const m of BLOCK_MARKERS) {
    if (raw.includes(m) || said.includes(m)) return m;
  }
  return null;
}

/** Phrases that mean "this record is gone" on a page that answered 200 anyway.
 *
 *  The mirror of BLOCK_MARKERS, and it exists for the same reason: the dangerous response
 *  is the one that does not announce itself in the status line. A site that serves a
 *  removed listing as a 200 "no longer available" page defeats a status-only oracle, and a
 *  status-only oracle then reports the record as merely lost, which is the one verdict
 *  that authorises a repair. Kept narrow on purpose: a false positive here marks a live
 *  record withdrawn. The phrases themselves live in learn/markers.ts, where the built-in
 *  list is the floor under a set a person can add to and the evidence can take away from. */
export function detectGone(body: string, source: string): string | null {
  // Visible text only, and this is not a refinement. Matching these phrases against raw
  // HTML reads a site's embedded JSON string tables as if they were the page speaking: a
  // live eBay listing ships "remove_success_message":"The item has been removed" inside a
  // script tag, which contains this oracle's own marker. Every live listing on the site
  // matched, and a match here marks a live safety recall withdrawn and takes it off the
  // feed. The bug was unreachable only while a plain fetch was being refused with a 403,
  // and probing through the Unlocker made it reachable on the first real page.
  // Normalised through the one function the learner also extracts phrases with. When
  // these were two different treatments of whitespace, a phrase learned from a page did
  // not match that page: `saidOnPage` in html.ts records why that mattered.
  const hay = saidOnPage(body);
  // The active set for THIS source, not the built-in one and not every site's: a phrase a
  // person accepted from the learner counts on the site it was learned from, and a phrase
  // the evidence later disproved does not count anywhere.
  for (const m of activeMarkersCached(source)) {
    if (hay.includes(m)) return m;
  }
  return null;
}

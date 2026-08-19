// What a reader actually sees on a page.
//
// This module exists because of a false positive that would have been very expensive.
// The withdrawal oracle matched its phrases against raw HTML, and a live eBay listing
// embeds a JSON string table inside a script tag:
//
//     "remove_success_message":"The item has been removed"
//
// That is a UI message template for a button the reader never pressed, and it contains
// the oracle's own gone-marker. Every live listing on the site matched, and a match
// there marks a live safety recall withdrawn and takes it off the feed.
//
// The bug was unreachable only for as long as a plain fetch was being refused with a
// 403. Probing through the Web Unlocker made real pages readable and it showed up on
// the first one. A page's script payload is not the page speaking; it is the vocabulary
// the page might use, which is close to the worst possible thing to match a status
// phrase against.

/** Visible text, with script and style CONTENTS removed rather than just their tags. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Collapse runs of horizontal whitespace, and only horizontal whitespace.
 *
 *  Newlines survive on purpose. `visibleText` turns every tag into one, so a newline is
 *  the boundary between two things the page said separately, and flattening it would let
 *  a phrase match across that boundary: `<li>listing</li><li>ended</li>` would read as
 *  "listing ended", which is a marker, and neither element said it. That is the same
 *  class of false positive this module was written to stop, one level down. Spaces and
 *  tabs inside a single run of text carry no such meaning. */
export function normaliseSpacing(s: string): string {
  return s.replace(/[^\S\n]+/g, " ");
}

/** What the page said, in the one form every phrase oracle matches against.
 *
 *  There is a single function for this because there used to be two, and they disagreed.
 *  The gone-marker learner collapsed whitespace when it extracted a candidate phrase and
 *  the oracle did not when it matched one, so a phrase learned from a page failed to
 *  match that same page the moment its wording carried an `&nbsp;`, a tab, or the double
 *  space an empty template value leaves behind. The learner would offer a marker, a
 *  person would accept it, and it would never fire.
 *
 *  That failure is not neutral. A withdrawal marker that does not fire leaves a removed
 *  listing looking merely missing, and missing-while-the-permalink-answers is the one
 *  verdict that authorises a repair. The bug turned "gone, refuse to heal" into "drift,
 *  heal it", which is the exact inversion this project exists to prevent. */
export function saidOnPage(html: string): string {
  return normaliseSpacing(visibleText(html)).toLowerCase();
}

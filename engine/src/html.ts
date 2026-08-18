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

// The block oracle had no test before this file, which is worth saying plainly: it
// lived unexported inside the live-wiring script, and that script calls `main()` on
// import, so nothing could reach it. The classifier's own tests take `blockSignature`
// as an input they are handed. The function that actually decides whether a body is a
// wall was the one part of that chain nobody checked.
//
// What these tests pin is the asymmetry, not either oracle alone. Two functions that
// look almost identical are allowed to disagree here, and the disagreement is the
// design: one is narrow because being wrong retires a live safety recall, the other is
// wide because being wrong only costs freshness while missing one authorises a repair
// against a wall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCK_MARKERS, detectBlock } from "./oracles.js";
import { detectGone } from "./oracles.js";

test("a wall that announces itself in visible text is a block", () => {
  const wall = `<html><body><h1>Verify you are a human</h1><p>Press and hold.</p></body></html>`;
  assert.equal(detectBlock(wall), "verify you are a human");
});

test("a wall whose only sentence is inside a script is still a block", () => {
  // This is the case the raw-body half of the check exists for. Plenty of anti-bot
  // pages render their message from JavaScript, so the visible text of the document as
  // served carries nothing. Reading visible text only, as the gone oracle must, would
  // hand these back as an ordinary page.
  const wall = `<html><head><script>window.onload=function(){document.title="Checking your browser";render("Checking your browser before you continue")}</script></head><body></body></html>`;
  assert.equal(detectBlock(wall), "checking your browser");
});

test("the same script payload is a block and is NOT a withdrawal", () => {
  // The whole asymmetry in one assertion. A page carrying a phrase inside its script
  // tables is not the page saying it, which is why the gone oracle refuses to look
  // there: a live eBay listing ships "The item has been removed" as a UI string and
  // every one of them would have been retired. A block is a claim we make about our own
  // access, we pay for it in staleness rather than in someone's safety, and the wrong
  // answer to lean toward is therefore the opposite one.
  const page = `<html><body><script>var s={"wall":"Access denied","gone":"This listing has ended"};</script><h1>Zimtown 5 gal portable gas can</h1><p>In stock</p></body></html>`;
  assert.equal(detectBlock(page), "access denied", "a carried wall signature still counts");
  assert.equal(detectGone(page, "tradewell"), null, "a carried gone phrase must never count");
});

test("an ordinary live page is neither blocked nor gone", () => {
  const page = `<html><body><h1>Zimtown 5 gal portable gas can</h1><p>In stock, ships today</p></body></html>`;
  assert.equal(detectBlock(page), null);
  assert.equal(detectGone(page, "tradewell"), null);
});

test("a block signature broken by template whitespace is still found", () => {
  // Same failure the gone oracle had. An `&nbsp;` or an empty interpolated value between
  // two words is enough to slip past a raw `includes`, and a missed wall is the
  // expensive direction.
  for (const wall of [
    `<html><body><h1>Unusual&nbsp; traffic from your network</h1></body></html>`,
    `<html><body><h1>Unusual  traffic from your network</h1></body></html>`,
    `<html><body><h1>Unusual\ttraffic from your network</h1></body></html>`,
  ]) {
    assert.equal(detectBlock(wall), "unusual traffic", `missed: ${JSON.stringify(wall)}`);
  }
});

test("every block signature is a phrase, not a fragment that could match a real page", () => {
  // A short signature is a substring, and this oracle stops a source and freezes the
  // feed on last-good. Cheap to be wrong, but not free.
  for (const m of BLOCK_MARKERS) {
    assert.ok(m.length >= 12, `${m} is short enough to appear in ordinary copy`);
    assert.ok(m.split(" ").length >= 2, `${m} is a single word`);
    assert.equal(m, m.toLowerCase(), `${m} must be lowercase, the haystack is`);
  }
});

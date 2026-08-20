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

// A withdrawal notice that a reader sees but the oracle does not.
//
// `visibleText` decoded five named entities and one numeric one (`&#39;`), which left
// every other numeric entity sitting in the haystack as literal text. A page saying
// "no longer&#160;available" reads to a person as the marker and to the oracle as a
// string with `&#160;` in the middle of it, so the marker did not fire. The same held
// for characters a reader cannot see at all: a zero-width space or a soft hyphen inside
// the phrase, which sites insert for line breaking, split the marker in the haystack
// while changing nothing on screen.
//
// The direction is what makes this worth pinning. A missed withdrawal marker leaves a
// removed record looking merely missing, and missing-while-the-permalink-answers is the
// one verdict that authorises a repair. The bug turns "gone, refuse to heal" into
// "drift, heal it", which republishes a recall for a product nobody is selling.
//
// The tag-split case is deliberately NOT here. `<p>no longer</p><p>available</p>` are
// two things the page said separately, and matching across that boundary is the false
// positive `normaliseSpacing` keeps newlines to prevent. Being wrong in that direction
// retires a live safety recall, so it stays unmatched on purpose.
test("a withdrawal marker written with a numeric non-breaking space still fires", () => {
  const dec = `<html><body><p>This listing is no longer&#160;available</p></body></html>`;
  const hex = `<html><body><p>This listing is no longer&#xA0;available</p></body></html>`;
  assert.equal(detectGone(dec, "arcadia"), "no longer available");
  assert.equal(detectGone(hex, "arcadia"), "no longer available");
});

test("characters a reader cannot see do not hide a withdrawal marker", () => {
  const zwsp = `<html><body><p>This listing is no longer ​available</p></body></html>`;
  const shy = `<html><body><p>This listing is no longer a­vailable</p></body></html>`;
  assert.equal(detectGone(zwsp, "arcadia"), "no longer available");
  assert.equal(detectGone(shy, "arcadia"), "no longer available");
});

test("a marker split across two elements still does not fire", () => {
  // The other direction, pinned so a fix for the entity gap cannot quietly widen into
  // this one. Two elements are two statements, and neither one said the marker.
  const split = `<html><body><li>no longer</li><li>available</li></body></html>`;
  assert.equal(detectGone(split, "arcadia"), null);
});

// --- walls that do not announce themselves in the status --------------------

test("a 200 that is really a wall is caught whatever words it uses", () => {
  // Seven wordings that a real rate limiter or interstitial serves at HTTP 200. Each
  // one used to pass straight through the block oracle and read as drift, which is the
  // failure the README says has already wedged two collectors.
  const walls = [
    "Too many requests from this IP, retry after 60 seconds",
    "Request was throttled",
    "Please slow down and try again later",
    "We are experiencing unusually high traffic",
    "Service temporarily unavailable. Please try again.",
    "Security check. We are verifying your connection.",
  ];

  for (const body of walls) {
    assert.notEqual(
      detectBlock(`<html><body><h1>${body}</h1></body></html>`),
      null,
      `not recognised as a wall: ${body}`
    );
  }
});

test("a status code quoted in prose is not treated as a wall", () => {
  // Deliberately not caught, and pinned here so nobody closes it by accident.
  //
  // A page that answers 200 while its body says "Error code 503-102" may well be a wall,
  // but the only way to catch it is to scan the body for status digits, and a recall
  // feed is the worst possible place to do that. "Model 503", a quantity, a house number
  // in an address: every one of them would put a live source behind a permanent false
  // wall, where it stops updating and refuses absence forever. The status line is where
  // a status belongs, and when a server actually sends 503 it is already caught.
  assert.equal(detectBlock("<html><body><p>Error code 503-102</p></body></html>"), null);
  assert.equal(detectBlock("<html><body><h1>Recall: Model 503 pressure washer</h1></body></html>"), null);
});

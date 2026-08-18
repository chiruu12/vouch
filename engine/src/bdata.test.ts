// The withdrawal oracle's own signal detectors.
//
// Both of these exist because a status code alone was not enough to tell a removed
// record from one we merely failed to read, and "merely failed to read" is the verdict
// that authorises a repair.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectGone, readUnlockerEnvelope, redirectedAway } from "./bdata.js";

describe("the withdrawal oracle's body and redirect signals", () => {
  it("reads an ended-listing page that answered 200", () => {
    assert.equal(
      detectGone("<html><body><h1>This listing is no longer available</h1></body></html>"),
      "no longer available"
    );
  });

  it("does not fire on an ordinary product page", () => {
    assert.equal(
      detectGone("<html><body><h1>Zimtown 5 gal portable gas can</h1><p>In stock</p></body></html>"),
      null
    );
  });

  it("treats a permalink redirected to another path as not-alive", () => {
    // A marketplace sending an ended listing to a category page answers 200 at the
    // end of the redirect, which made a removed record look present.
    assert.equal(
      redirectedAway("https://m.test/item/TW-33887.html", "https://m.test/category/fuel-cans"),
      "permalink redirected to /category/fuel-cans"
    );
  });

  it("ignores redirects that land on the same record", () => {
    // Scheme upgrades, host aliases and trailing slashes are the same page, and
    // treating them as withdrawals would mark live records gone.
    assert.equal(redirectedAway("http://m.test/item/a.html", "https://m.test/item/a.html"), null);
    assert.equal(redirectedAway("https://m.test/item/a/", "https://www.m.test/item/a"), null);
    assert.equal(redirectedAway("https://m.test/item/A.html", "https://m.test/item/a.html"), null);
  });

  it("says nothing when either URL is unparseable", () => {
    assert.equal(redirectedAway("not a url", "also not a url"), null);
  });
});

// The Web Unlocker escalation.
//
// The oracle's second transport exists because a real marketplace permalink answers 403
// to a plain request, so without it a withdrawal can never be established on the sites
// this project is actually for. The danger it introduces is that Bright Data's own
// failures arrive looking like the target's answer: a navigation timeout comes back as
// a 502 carrying `x-brd-error`. Reading either as the site's reply would turn an
// infrastructure blip into a withdrawal, and a withdrawal is the verdict that stops a
// record being served. These assert that only the target's own answer gets through.
describe("reading a Web Unlocker envelope", () => {
  const url = "https://www.ebay.com/itm/306847319423";

  it("takes the status and body the target actually returned", () => {
    const out = `Scraping ${url}...\n{"status_code":200,"headers":{"server":"ebay-proxy-server"},"body":"<html>live</html>"}`;
    const probe = readUnlockerEnvelope(out, url);
    assert.equal(probe?.status, 200);
    assert.equal(probe?.body, "<html>live</html>");
    assert.equal(probe?.bytes, "<html>live</html>".length);
  });

  it("passes a genuine 404 through, because that is the target answering", () => {
    const out = `{"status_code":404,"headers":{},"body":"not found"}`;
    assert.equal(readUnlockerEnvelope(out, url)?.status, 404);
  });

  it("refuses an envelope carrying x-brd-error", () => {
    // Observed verbatim from a live call during development.
    const out =
      `{"status_code":502,"headers":{"x-brd-error":"Navigation timeout @ ${url}",` +
      `"x-brd-error-code":"navigation_timeout"},"body":""}`;
    assert.equal(readUnlockerEnvelope(out, url), null, "their failure is not the site's answer");
  });

  it("refuses a 5xx even when no error header is set", () => {
    const out = `{"status_code":503,"headers":{},"body":""}`;
    assert.equal(readUnlockerEnvelope(out, url), null);
  });

  it("refuses output that is not an envelope at all", () => {
    assert.equal(readUnlockerEnvelope("command not found", url), null);
    assert.equal(readUnlockerEnvelope('{"headers":{}}', url), null, "no status is not a status");
    assert.equal(readUnlockerEnvelope("{not json", url), null);
  });

  it("does not invent a landing URL it was never told", () => {
    // The Unlocker does not report where it ended up, so finalUrl must stay as asked.
    // A redirect therefore reads as unresolved, which refuses, rather than as gone.
    const out = `{"status_code":200,"headers":{},"body":"x"}`;
    assert.equal(readUnlockerEnvelope(out, url)?.finalUrl, url);
  });
});

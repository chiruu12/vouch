// The withdrawal oracle's own signal detectors.
//
// Both of these exist because a status code alone was not enough to tell a removed
// record from one we merely failed to read, and "merely failed to read" is the verdict
// that authorises a repair.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectGone, redirectedAway } from "./bdata.js";

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

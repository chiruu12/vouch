// The learner and the oracle have to agree about what the page said.
//
// One extracts phrases from a page, the other looks for phrases on a page, and for a
// while they did it differently: the learner collapsed whitespace and the oracle did
// not. A phrase learned from a page then failed to match that same page as soon as its
// wording carried an `&nbsp;`, a tab, or the double space an empty template value leaves
// behind. The learner would offer the marker, a person would read the evidence and
// accept it, and it would never fire on anything.
//
// The direction of that failure is the reason this file exists rather than a one-line
// fix and no test. A withdrawal marker that does not fire leaves a removed listing
// looking merely missing, and missing-while-its-permalink-answers is the single verdict
// that authorises a repair. So the bug did not make the oracle useless, it made it
// wrong: "gone, refuse to heal" became "drift, heal it", which is the inversion this
// whole project is built to prevent.
//
// The first test is a property rather than an example on purpose. The bug was not any
// one phrase, it was that two functions could disagree at all, and an example only pins
// the shapes somebody thought of.

import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatePhrases } from "./gone-markers.js";
import { saidOnPage, normaliseSpacing } from "../html.js";
import { BUILTIN_MARKERS } from "./markers.js";

/** The whitespace a real page puts between two words. Every one of these appears in
 *  ordinary marketplace markup: `&nbsp;` beside a space, a template value that rendered
 *  empty, a tab from a pretty-printer, a wrapped source line. */
const GAPS = [" ", "  ", "   ", "\t", " \t ", "&nbsp; ", " &nbsp;", "\n"];

const WORDING = [
  "this particular listing was ended by the seller",
  "we could not find the item you are looking for",
  "looks like this page is missing",
  "the seller has closed this listing early",
];

test("every phrase the learner can propose is findable by the oracle on that same page", () => {
  let checked = 0;
  for (const wording of WORDING) {
    const words = wording.split(" ");
    for (const gap of GAPS) {
      // Rebuild the sentence with this gap at each position in turn, so a page that
      // spaces one join oddly is covered as well as one that spaces them all oddly.
      for (let i = 1; i < words.length; i++) {
        const spaced = words.slice(0, i).join(" ") + gap + words.slice(i).join(" ");
        const page = `<html><body><div class="notice">${spaced}</div></body></html>`;
        const hay = saidOnPage(page);
        for (const phrase of candidatePhrases(page)) {
          assert.ok(
            hay.includes(phrase),
            `the learner proposed ${JSON.stringify(phrase)} from a page the oracle ` +
              `cannot find it on. haystack: ${JSON.stringify(hay)}`
          );
          checked++;
        }
      }
    }
  }
  // A property test that never reached a candidate would pass while checking nothing.
  assert.ok(checked > 100, `expected to check many candidates, checked ${checked}`);
});

test("a page whose wording is broken by a tag yields no phrase spanning the break", () => {
  // `<b>` inside a sentence is a real thing sites do, and the two halves are separate
  // things the page said. Neither the learner nor the oracle may join them.
  const page = `<html><body><div>this particular listing was <b>ended</b> by the seller</div></body></html>`;
  const hay = saidOnPage(page);
  assert.ok(!hay.includes("was ended by"), "a tag boundary must survive normalisation");
  for (const phrase of candidatePhrases(page)) {
    assert.ok(!phrase.includes("was ended by"), `learner joined across a tag: ${phrase}`);
  }
});

test("normalisation does not let a marker match across two elements", () => {
  // The dangerous widening. Two list items that separately say ordinary words must not
  // add up to a withdrawal phrase, or a page's navigation can retire a live recall.
  const page = `<html><body><ul><li>listing</li><li>ended</li></ul></body></html>`;
  assert.ok(
    !saidOnPage(page).includes("listing ended"),
    "collapsing newlines would make two elements say something neither one said"
  );
  assert.ok(BUILTIN_MARKERS.includes("listing ended"), "the phrase above is a real marker");
});

test("normaliseSpacing collapses horizontal runs and keeps newlines", () => {
  assert.equal(normaliseSpacing("a  \t b"), "a b");
  assert.equal(normaliseSpacing("a\nb"), "a\nb");
  assert.equal(normaliseSpacing("a \n b"), "a \n b", "a single space is already collapsed");
  assert.equal(normaliseSpacing("a  \n  b"), "a \n b", "runs either side of a newline still collapse");
  assert.equal(normaliseSpacing("a\n\n\nb"), "a\n\n\nb", "blank lines are still boundaries");
});

test("the oracle still reads only what the page says, not what it carries", () => {
  // The guarantee that predates this file, re-asserted because normalisation now runs
  // over the same text. A live listing shipping a marker inside a script payload is the
  // false positive that made visibleText necessary in the first place.
  const live = `<html><body><script>var t={"remove_success_message":"This listing has ended"};</script><h1>Zimtown gas can</h1><p>In stock</p></body></html>`;
  assert.ok(!saidOnPage(live).includes("this listing has ended"));
});

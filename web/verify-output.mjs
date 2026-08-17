// Check the built HTML against the snapshot it was built from.
//
// The engine refuses to serve data it has not measured. This is the same rule applied
// one layer out: the feed makes two promises about its own rendering, and a promise
// nobody checks is a convention. Both are checked here, against the exported HTML
// rather than the component tree, because what ships is the HTML.
//
//   1. Every string the engine wrote appears verbatim. Refusals, classifier evidence,
//      contract breaches, repair prompts, quarantine reasons and the match caveat are
//      quoted whole. A truncation, a paraphrase, or a "show more" that hides half a
//      refusal all fail here. A shortened refusal reads as a softer refusal.
//
//   2. No seller identity reaches the page. The published type has no seller field, so
//      this should be impossible, which is exactly why it is worth asserting: the leak
//      we are guarding against is a field surviving a spread nobody narrowed.
//
// Run after `next build`. Exits non-zero on any failure, so the build fails rather than
// shipping a page that quietly breaks one of them.
//
//   node verify-output.mjs

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "out";
const SNAPSHOT = "public/snapshot.json";

function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(p));
    else if (entry.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// Entities back to characters, tags out, whitespace flattened. Flattening matters: the
// renderer is free to wrap a long refusal across lines and that is not an alteration.
function readable(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;/g, "’")
    .replace(/\s+/g, " ");
}

const flat = (s) => s.replace(/\s+/g, " ").trim();

const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const files = htmlFiles(OUT);
if (files.length === 0) {
  console.error(`no HTML in ${OUT}/. Run \`next build\` first.`);
  process.exit(2);
}

const raw = files.map((f) => readFileSync(f, "utf8")).join("\n");

// Per page, not concatenated. The first version of this check joined every page into one
// blob and asked whether each string appeared in it, which passed a deliberately
// truncated refusal: the same refusal is quoted on the front page and in the incident
// log, and the intact copy satisfied the search for the mangled one. A check that
// reports success without establishing the property is worse than no check.
const pages = files.map((f) => ({ file: f, text: readable(readFileSync(f, "utf8")) }));

// --- 1. verbatim ------------------------------------------------------------

/** Every string the engine authored, with a label for the failure message. */
const engineStrings = [];
for (const i of snap.incidents) {
  const at = `incident ${i.id}`;
  if (i.refusal) engineStrings.push([`${at} refusal`, i.refusal]);
  if (i.prompt) engineStrings.push([`${at} repair prompt`, i.prompt]);
  i.evidence.forEach((l, n) => engineStrings.push([`${at} evidence[${n}]`, l]));
  i.breaches.forEach((l, n) => engineStrings.push([`${at} breach[${n}]`, l]));
}
for (const q of snap.study.quarantineReasons) {
  engineStrings.push([`study quarantine reason`, q.reason]);
}
engineStrings.push(["match caveat", snap.caveat]);

/** How much of a string has to match before we hold a page to the whole of it. Long
 *  enough not to fire on a coincidence, short enough that a page which truncates early
 *  still trips it. */
const OPENING = 40;

const altered = [];
let renderings = 0;

for (const [where, s] of engineStrings) {
  const want = flat(s);
  const opening = want.slice(0, OPENING);
  // A string shorter than the opening window is all-or-nothing anyway.
  const attempted = pages.filter((p) => p.text.includes(opening));

  if (attempted.length === 0) {
    // Nothing renders it. Not a truncation, but the snapshot carries text no page shows,
    // which is its own kind of quiet omission and worth naming.
    altered.push([`${where} (rendered nowhere)`, s]);
    continue;
  }
  for (const p of attempted) {
    renderings++;
    if (!p.text.includes(want)) altered.push([`${where} in ${p.file}`, s]);
  }
}

// --- 2. no seller identity --------------------------------------------------

// `sk_` catches the hash, the rest catch a raw field surviving from a capture. Checked
// against the raw HTML, not the readable text, so an attribute value cannot hide.
const BANNED = ["sellerKey", "seller_name", '"seller"', "sk_"];
const leaked = BANNED.filter((b) => raw.includes(b));

// --- report -----------------------------------------------------------------

console.log(`pages checked          ${files.length}`);
console.log(`engine strings         ${engineStrings.length}`);
console.log(`renderings checked     ${renderings}`);
console.log(`altered or missing     ${altered.length}`);
console.log(`seller identity found  ${leaked.length}`);

for (const [where, s] of altered) {
  console.error(`\nNOT VERBATIM: ${where}`);
  console.error(`  expected: ${flat(s).slice(0, 160)}`);
}
for (const b of leaked) {
  console.error(`\nSELLER IDENTITY PUBLISHED: found "${b}" in the built HTML`);
}

if (altered.length > 0 || leaked.length > 0) {
  console.error(
    `\n${altered.length} engine string(s) altered, ${leaked.length} seller field(s) leaked.`
  );
  process.exit(1);
}

console.log("\nok: every engine string is verbatim and no seller identity is published");

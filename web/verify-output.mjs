// Check the built HTML against the snapshot it was built from.
//
// The engine refuses to serve data it has not measured. This is the same rule applied
// one layer out: the feed makes promises about its own rendering, and a promise nobody
// checks is a convention. They are checked here against the exported HTML rather than
// the component tree, because what ships is the HTML.
//
//   1. Every string the engine wrote appears verbatim, on every page that is supposed
//      to carry it. Refusals, classifier evidence, contract breaches, repair prompts,
//      quarantine reasons, match contradictions and the match caveat are quoted whole.
//      A truncation at either end, a paraphrase, or a whole section deleted from one
//      page all fail here. A shortened refusal reads as a softer refusal.
//
//   2. Nothing on the page is hidden by markup or CSS. This one is a blunt ban rather
//      than a measurement, for a reason given at the check.
//
//   3. No seller identity reaches the page. The published type has no seller field, so
//      this should be impossible, which is exactly why it is worth asserting: the leak
//      we are guarding against is a field surviving a spread nobody narrowed.
//
// Three earlier versions of this file passed mutations it claimed to catch. Each hole
// is described at the check that now closes it, because the holes are more instructive
// than the rules.
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

// Script and style contents go first, before tags are stripped.
//
// Hole 3, found by audit and confirmed in the bytes: a static Next export inlines the
// RSC flight payload as `self.__next_f.push([1,"..."])`, which carries every
// server-rendered string. Stripping only the tags left that payload in the text, so a
// string could be deleted from the DOM entirely and still satisfy the check from its
// own copy in the payload. Confirmed on out/incidents.html, where a contract breach
// appeared at offset 8929 in the DOM and again at 29953 inside a script. That is the
// concatenation bug from version one, reopened one level down: the check could not tell
// "rendered" from "present somewhere in the file".
//
// Entities then go back to characters, tags come out, whitespace is flattened.
// Flattening matters: the renderer is free to wrap a long refusal across lines and that
// is not an alteration.
function readable(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
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
const pages = files.map((f) => ({
  file: f,
  route: f.slice(OUT.length + 1),
  text: readable(readFileSync(f, "utf8")),
}));

const page = (route) => {
  const p = pages.find((x) => x.route === route);
  if (p === undefined) {
    console.error(`expected ${OUT}/${route} in the export. Routes found: ${pages.map((x) => x.route).join(", ")}`);
    process.exit(2);
  }
  return p;
};

const FEED = "index.html";
const LOG = "incidents.html";
const METHOD = "method.html";

// --- what has to be where -----------------------------------------------------
//
// Hole 5: naming the pages is the point. The old check asked whether a string appeared
// on *some* page, so deleting the front page's refusal section entirely still passed,
// because the incident log carried the same three refusals. That section is the
// hierarchy argument, and a regression removing it went green. A string now names the
// pages that must carry it, and each of them is held to the whole of it.

/** @type {{where: string, text: string, on: string[]}[]} */
const required = [];
const need = (where, text, on) => {
  if (typeof text === "string" && text.trim() !== "") required.push({ where, text, on });
};

for (const i of snap.incidents) {
  const at = `incident ${i.id}`;
  // The feed's front page carries the refusals it counts, which is refusals we made.
  // A deferral carries a refusal string but is not one, so the front page omits it and
  // this does too. See app/page.tsx and the snapshot builder for why that matters.
  const onFeed = i.refusal !== null && !i.healDeferred;
  need(`${at} refusal`, i.refusal, onFeed ? [FEED, LOG] : [LOG]);
  need(`${at} repair prompt`, i.prompt, i.healAttempted ? [LOG] : []);
  i.evidence.forEach((l, n) => need(`${at} evidence[${n}]`, l, [LOG]));
  i.breaches.forEach((l, n) => need(`${at} breach[${n}]`, l, [LOG]));
}

for (const q of snap.study.quarantineReasons) {
  need(`study quarantine reason`, q.reason, [METHOD]);
}

// Hole 4: matcher-authored sentences were engine text the check never looked at. The
// capacity contradictions happen to coincide with quarantine reasons today, so they were
// covered by accident on one page; a contradiction that is not also a study reason was
// unchecked entirely, as were the worked-example renderings.
for (const e of snap.study.examples) {
  need(`study example contradiction`, e.contradiction, [METHOD]);
}
for (const r of snap.recalls) {
  for (const l of [...(r.onSale ?? []), ...(r.quarantined ?? [])]) {
    need(`listing contradiction under ${r.ref}`, l.match?.contradiction, [FEED]);
  }
}

need("match caveat", snap.caveat, [FEED, METHOD]);

// --- 1. verbatim, on the pages that owe it ------------------------------------

const WINDOW = 40;

/** Sliding windows, not just the opening one.
 *
 *  Hole 1: the old check held a page to the whole string only if it contained the
 *  string's first 40 characters, which exempted any page that altered the *start*.
 *  Rendering `{i.refusal.slice(38)}` on the front page dropped it out of the checked
 *  set while the intact incident log satisfied the search, so a head-truncated refusal
 *  shipped green. Tail truncation was caught and head truncation was not, which is the
 *  same bug wearing the other shoe. Any window matching now pulls the page in. */
function attempts(pageText, want) {
  if (want.length <= WINDOW) return pageText.includes(want.slice(0, WINDOW));
  for (let i = 0; i + WINDOW <= want.length; i++) {
    if (pageText.includes(want.slice(i, i + WINDOW))) return true;
  }
  return false;
}

const altered = [];
let renderings = 0;

for (const { where, text, on } of required) {
  const want = flat(text);
  for (const route of on) {
    renderings++;
    if (!page(route).text.includes(want)) {
      altered.push([`${where}: not verbatim on ${route}`, want]);
    }
  }
}

/** Engine strings nest. A refusal quotes the breaches that caused it, semicolon-joined,
 *  so the front page contains breach text as a genuine part of the refusal it owes.
 *  Scanning raw page text for stray fragments therefore reports every nesting as a
 *  truncation. The residue is the page with every string it carries whole removed,
 *  longest first so a container is consumed before the strings inside it. What is left
 *  is text no accounted-for string explains, which is where a real fragment would sit. */
const wholes = [...new Set(required.map((r) => flat(r.text)))].sort((a, b) => b.length - a.length);
for (const p of pages) {
  p.residue = wholes.reduce((t, w) => t.split(w).join(" "), p.text);
}

for (const { where, text, on } of required) {
  const want = flat(text);
  for (const p of pages) {
    if (on.includes(p.route) || p.route === "404.html") continue;
    if (attempts(p.residue, want)) {
      renderings++;
      altered.push([`${where}: fragment on ${p.route}, which does not carry it whole`, want]);
    }
  }
}

// --- 2. nothing hidden --------------------------------------------------------
//
// Hole 2: the old header claimed a "show more" that hides half a refusal would fail
// here. It would not. `readable()` proves presence in the source, not visibility, so
// wrapping a refusal in <details> or a display:none span passed while showing the
// reader half of it. A text check cannot measure visibility, so rather than keep a
// claim the code did not back, the constructs are banned outright. The feed uses none
// of them today, so the ban costs nothing and the next person to reach for one has to
// argue with this check first.
const HIDING = ["<details", "<summary", "display:none", "display: none", "visibility:hidden", "visibility: hidden", "font-size:0", "-webkit-line-clamp", "text-overflow:ellipsis"];
const css = readdirSync(join(OUT, "_next", "static", "css"))
  .map((f) => readFileSync(join(OUT, "_next", "static", "css", f), "utf8"))
  .join("\n");
const hidden = HIDING.filter((h) => raw.includes(h) || css.includes(h));

// --- 3. no seller identity ----------------------------------------------------

// `sk_` catches the hash, the rest catch a raw field surviving from a capture. Checked
// against the raw HTML, not the readable text, so an attribute value cannot hide.
const BANNED = ["sellerKey", "seller_name", '"seller"', "sk_"];
const leaked = BANNED.filter((b) => raw.includes(b));

// --- report -------------------------------------------------------------------

console.log(`pages checked          ${files.length}`);
console.log(`engine strings         ${required.length}`);
console.log(`renderings required    ${renderings}`);
console.log(`altered or missing     ${altered.length}`);
console.log(`hidden by markup/css   ${hidden.length}`);
console.log(`seller identity found  ${leaked.length}`);

for (const [where, s] of altered) {
  console.error(`\nNOT VERBATIM: ${where}`);
  console.error(`  expected: ${s.slice(0, 160)}`);
}
for (const h of hidden) {
  console.error(`\nHIDDEN CONTENT: found "${h}" in the built output. Engine text is quoted whole or not at all.`);
}
for (const b of leaked) {
  console.error(`\nSELLER IDENTITY PUBLISHED: found "${b}" in the built HTML`);
}

if (altered.length > 0 || hidden.length > 0 || leaked.length > 0) {
  console.error(
    `\n${altered.length} engine string(s) altered, ${hidden.length} hiding construct(s), ${leaked.length} seller field(s) leaked.`
  );
  process.exit(1);
}

console.log("\nok: every engine string is verbatim on the pages that owe it, nothing is hidden, no seller identity is published");

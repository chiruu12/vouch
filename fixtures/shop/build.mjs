#!/usr/bin/env node
// Builds the Tradewell marketplace fixture in several markup variants.
//
// Each variant is a different shape of the SAME data, so a scraper trained on
// one variant breaks in a specific, chosen way on another. That is the point:
// we cannot ask a real marketplace to redesign, bot-block, or delist on cue.
//
//   node build.mjs                 # build every variant into dist/
//   node build.mjs baseline        # build one
//
// Variants:
//   baseline   what the scraper is trained against
//   redesign   layout drift: classes renamed, price nested behind a data-testid,
//              "Condition" relabelled "Item condition", prices prefixed "US $"
//   delisted   three recall-linked listings removed, permalinks 404.
//              In this domain the seller complied; healing would fabricate an accusation.
//   blocked    every route is an anti-bot interstitial (HTTP 200 on purpose)

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, "data.json"), "utf8"));

const CSS = `
:root { --ink:#1a1c1e; --muted:#5b6166; --line:#d4d8dc; --bg:#fff; --price:#0d5c0d; --accent:#1a5f7a; }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg); }
.fixture-banner { background:#fff4e5; border-bottom:2px solid #d68000; padding:.75rem 1.25rem; font-size:.875rem; }
.fixture-banner strong { color:#8a5200; }
header.site { border-bottom:1px solid var(--line); padding:1.25rem; }
header.site .crest { font-weight:700; letter-spacing:.02em; color:var(--accent); }
header.site .dept { color:var(--muted); font-size:.9rem; }
main { max-width:52rem; margin:0 auto; padding:1.5rem 1.25rem 3rem; }
h1 { font-size:1.75rem; margin:0 0 .35rem; }
.lede { color:var(--muted); margin:0 0 1.5rem; }
.result-count { font-size:.9rem; color:var(--muted); margin:0 0 1rem; }
ul { list-style:none; margin:0; padding:0; }
li { border:1px solid var(--line); border-radius:4px; padding:1rem 1.1rem; margin-bottom:1rem; }
.sku { font-size:.8rem; color:var(--muted); font-variant-numeric:tabular-nums; }
h3 { font-size:1.1rem; margin:.15rem 0 .35rem; }
.price, [data-testid="price-amount"] { font-size:1.2rem; font-weight:700; color:var(--price); }
.price { margin:.2rem 0 .7rem; }
dl { display:grid; grid-template-columns:9.5rem 1fr; gap:.3rem .9rem; margin:0; font-size:.925rem; }
dt { color:var(--muted); }
dd { margin:0; }
nav.pager { margin-top:1.5rem; display:flex; gap:1rem; align-items:center; font-size:.925rem; }
nav.pager .current { font-weight:600; }
.challenge { max-width:28rem; margin:3rem auto; padding:2rem 1.5rem; border:1px solid var(--line); border-radius:6px; text-align:center; }
.challenge p { color:var(--muted); }
.challenge button { margin-top:.75rem; padding:.5rem 1.1rem; font:inherit; cursor:pointer; }
`.trim();

const BANNER = `
<div class="fixture-banner">
  <strong>SYNTHETIC TEST FIXTURE.</strong>
  Tradewell is a fictional marketplace and this is not a real listing site. This page exists so that Vouch
  can demonstrate scraper breakage and repair against a target it is permitted to change.
  Every listing below is invented. Nothing here is for sale.
</div>`.trim();

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const usd = (n) => `$${Number(n).toFixed(2)}`;
const usdLong = (n) => `US $${Number(n).toFixed(2)}`;

// Three recall-linked listings. Removing them is compliance, not layout drift.
// A healer that invents replacements would accuse sellers who already took the items down.
const DELISTED_IDS = ["TW-88214", "TW-44903", "TW-33887"];

// --- record templates -------------------------------------------------------

// Baseline: class-based hooks, $41.99 prices, "Condition" label.
const recordBaseline = (r) => `
    <li class="result-card" data-item-id="${esc(r.id)}">
      <div class="result-card__id sku">${esc(r.id)}</div>
      <h3 class="result-card__title"><a class="result-card__link" href="/item/${esc(r.id)}.html">${esc(r.title)}</a></h3>
      <p class="result-card__price price">${esc(usd(r.price))}</p>
      <dl class="result-meta">
        <dt>Brand</dt><dd class="result-card__brand">${esc(r.brand)}</dd>
        <dt>Condition</dt><dd class="result-card__condition">${esc(r.condition)}</dd>
        <dt>Seller</dt><dd class="result-card__seller">${esc(r.sellerHandle)}</dd>
        <dt>Location</dt><dd class="result-card__location">${esc(r.location)}</dd>
        <dt>Shipping</dt><dd class="result-card__shipping">${esc(r.shipping)}</dd>
        <dt>Listed</dt><dd class="result-card__date">${esc(r.listedOn)}</dd>
      </dl>
    </li>`;

// Redesign: every class hook renamed, price wrapped in a nested span behind a
// data-testid, condition label reworded, prices rendered as "US $41.99".
const recordRedesign = (r) => `
    <li class="tile" data-listing-ref="${esc(r.id)}">
      <div class="tile__sku sku">${esc(r.id)}</div>
      <h3 class="tile__heading"><a data-testid="item-link" href="/item/${esc(r.id)}.html">${esc(r.title)}</a></h3>
      <p class="tile__cost price"><span data-testid="price-amount">${esc(usdLong(r.price))}</span></p>
      <dl class="tile-detail">
        <dt>Brand</dt><dd data-testid="brand">${esc(r.brand)}</dd>
        <dt>Item condition</dt><dd data-testid="item-condition">${esc(r.condition)}</dd>
        <dt>Seller</dt><dd data-testid="seller-handle">${esc(r.sellerHandle)}</dd>
        <dt>Location</dt><dd data-testid="ship-from">${esc(r.location)}</dd>
        <dt>Shipping</dt><dd data-testid="shipping">${esc(r.shipping)}</dd>
        <dt>Listed</dt><dd data-testid="listed-on">${esc(r.listedOn)}</dd>
      </dl>
    </li>`;

// --- detail pages ----------------------------------------------------------
//
// Every listing gets its own permalink. This is the load-bearing part of the
// fixture, not decoration: a delisted item's public URL 404s, so permalink
// liveness is how we tell "the page changed shape" (heal) from "this item is
// gone" (never heal; the seller complied).

const detailPage = (r) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(r.id)} ${esc(r.title)} - ${esc(data.marketplace)} (TEST FIXTURE)</title>
  <style>
${CSS}
  </style>
</head>
<body>

${BANNER}

<header class="site">
  <div class="crest">${esc(data.marketplace)}</div>
  <div class="dept">${esc(data.tagline)}</div>
</header>

<main>
  <p class="result-count"><a href="/">Back to all listings</a></p>
  <div class="sku">${esc(r.id)}</div>
  <h1>${esc(r.title)}</h1>
  <p class="price">${esc(usd(r.price))}</p>
  <dl class="result-meta">
    <dt>Brand</dt><dd class="result-card__brand">${esc(r.brand)}</dd>
    <dt>Condition</dt><dd class="result-card__condition">${esc(r.condition)}</dd>
    <dt>Seller</dt><dd class="result-card__seller">${esc(r.sellerHandle)}</dd>
    <dt>Location</dt><dd class="result-card__location">${esc(r.location)}</dd>
    <dt>Shipping</dt><dd class="result-card__shipping">${esc(r.shipping)}</dd>
    <dt>Listed</dt><dd class="result-card__date">${esc(r.listedOn)}</dd>
  </dl>
</main>

</body>
</html>
`;

// HTTP 200 on purpose: the nasty real-world case is a block that does not
// announce itself with a 4xx. The classifier keys on the signature string.
const challengePage = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Just a moment - ${esc(data.marketplace)} (TEST FIXTURE)</title>
  <style>
${CSS}
  </style>
</head>
<body>

${BANNER}

<header class="site">
  <div class="crest">${esc(data.marketplace)}</div>
  <div class="dept">${esc(data.tagline)}</div>
</header>

<main>
  <div class="challenge">
    <h1>Verify you are a human</h1>
    <p>Complete the check to continue to listings. Automated requests are held here.</p>
    <button type="button">Continue</button>
  </div>
</main>

</body>
</html>
`;

// --- page assembly ---------------------------------------------------------

function page({ records, pageNum, pageCount, total, shown, renderRecord, listClass }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Search results - ${esc(data.marketplace)} (TEST FIXTURE)</title>
  <style>
${CSS}
  </style>
</head>
<body>

${BANNER}

<header class="site">
  <div class="crest">${esc(data.marketplace)}</div>
  <div class="dept">${esc(data.tagline)}</div>
</header>

<main>
  <h1>All listings</h1>
  <p class="lede">Items from sellers across the marketplace.</p>
  <p class="result-count">${total} listings. Showing ${shown}.</p>

  <ul class="${listClass}">
${records.map(renderRecord).join("\n")}
  </ul>

  <nav class="pager">
    <span class="current">Page ${pageNum} of ${pageCount}</span>
${pageNum < pageCount ? `    <a class="pager__next" href="/page-${pageNum + 1}.html">Next page</a>` : ""}
${pageNum > 1 ? `    <a class="pager__prev" href="${pageNum === 2 ? "/" : `/page-${pageNum - 1}.html`}">Previous page</a>` : ""}
  </nav>
</main>

</body>
</html>
`;
}

const VARIANTS = {
  baseline: { renderRecord: recordBaseline, listClass: "result-list", records: data.listings },
  redesign: { renderRecord: recordRedesign, listClass: "tile-list", records: data.listings },
  delisted: {
    renderRecord: recordBaseline,
    listClass: "result-list",
    records: data.listings.filter((r) => !DELISTED_IDS.includes(r.id)),
  },
  blocked: { interstitial: true },
};

function build(name) {
  const v = VARIANTS[name];
  if (!v) throw new Error(`unknown variant: ${name}. known: ${Object.keys(VARIANTS).join(", ")}`);

  const outDir = join(here, "dist", name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  if (v.interstitial) {
    const html = challengePage();
    writeFileSync(join(outDir, "index.html"), html);
    writeFileSync(join(outDir, "page-1.html"), html);
    writeFileSync(join(outDir, "page-2.html"), html);
    mkdirSync(join(outDir, "item"), { recursive: true });
    for (const r of data.listings) {
      writeFileSync(join(outDir, "item", `${r.id}.html`), html);
    }
    console.log(
      `built blocked: 0 listings (anti-bot interstitial on every route) -> fixtures/shop/dist/blocked/`
    );
    return;
  }

  const per = data.perPage;
  const total = v.records.length;
  const pageCount = Math.ceil(total / per);

  for (let p = 1; p <= pageCount; p++) {
    const slice = v.records.slice((p - 1) * per, p * per);
    const from = (p - 1) * per + 1;
    const to = from + slice.length - 1;
    const html = page({
      records: slice,
      pageNum: p,
      pageCount,
      total,
      shown: `${from} to ${to}`,
      renderRecord: v.renderRecord,
      listClass: v.listClass,
    });
    writeFileSync(join(outDir, p === 1 ? "index.html" : `page-${p}.html`), html);
    // Page 1 is reachable both as / and as /page-1.html. Real listings commonly
    // serve both, and a scraper that infers the /page-N.html pattern from page 2
    // will ask for page-1.html rather than the bare root.
    if (p === 1) writeFileSync(join(outDir, "page-1.html"), html);
  }

  // Permalinks. A listing absent here 404s, which is the delisted signal.
  mkdirSync(join(outDir, "item"), { recursive: true });
  for (const r of v.records) {
    writeFileSync(join(outDir, "item", `${r.id}.html`), detailPage(r));
  }

  const omitted = data.listings.length - total;
  console.log(
    `built ${name}: ${total} listings across ${pageCount} page(s), ${total} permalinks` +
      (omitted ? `, ${omitted} delisted (permalink now 404s)` : "") +
      ` -> fixtures/shop/dist/${name}/`
  );
}

const requested = process.argv.slice(2);
(requested.length ? requested : Object.keys(VARIANTS)).forEach(build);

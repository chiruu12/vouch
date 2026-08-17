#!/usr/bin/env node
// Builds the Arcadia fixture in several markup variants.
//
// Each variant is a different shape of the SAME data, so a scraper trained on
// one variant breaks in a specific, chosen way on another. That is the point:
// we cannot ask a real regulator to redesign on cue, so we own a target that can.
//
//   node build.mjs                 # build every variant into dist/
//   node build.mjs baseline        # build one
//
// Variants:
//   baseline   what the scraper is trained against
//   redesign   layout drift: classes renamed, risk nested deeper, date reformatted,
//              "Batch codes" relabelled "Affected units"
//   withdrawn  one notice removed from the listing entirely, count adjusted.
//              This is the case a naive healer gets WRONG by inventing a replacement.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, "data.json"), "utf8"));

const CSS = `
:root { --ink:#1a1c1e; --muted:#5b6166; --line:#d4d8dc; --bg:#fff; --serious:#a4262c; }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg); }
.fixture-banner { background:#fff4e5; border-bottom:2px solid #d68000; padding:.75rem 1.25rem; font-size:.875rem; }
.fixture-banner strong { color:#8a5200; }
header.site { border-bottom:1px solid var(--line); padding:1.25rem; }
header.site .crest { font-weight:700; letter-spacing:.02em; }
header.site .dept { color:var(--muted); font-size:.9rem; }
main { max-width:52rem; margin:0 auto; padding:1.5rem 1.25rem 3rem; }
h1 { font-size:1.75rem; margin:0 0 .35rem; }
.lede { color:var(--muted); margin:0 0 1.5rem; }
.result-count { font-size:.9rem; color:var(--muted); margin:0 0 1rem; }
ul { list-style:none; margin:0; padding:0; }
li { border:1px solid var(--line); border-radius:4px; padding:1rem 1.1rem; margin-bottom:1rem; }
.ref { font-size:.8rem; color:var(--muted); font-variant-numeric:tabular-nums; }
h3 { font-size:1.1rem; margin:.15rem 0 .75rem; }
dl { display:grid; grid-template-columns:9.5rem 1fr; gap:.3rem .9rem; margin:0; font-size:.925rem; }
dt { color:var(--muted); }
dd { margin:0; }
.risk { font-weight:600; }
.risk[data-level="Serious"], [data-testid="risk-band"][data-level="Serious"] { color:var(--serious); }
nav.pager { margin-top:1.5rem; display:flex; gap:1rem; align-items:center; font-size:.925rem; }
nav.pager .current { font-weight:600; }
`.trim();

const BANNER = `
<div class="fixture-banner">
  <strong>SYNTHETIC TEST FIXTURE.</strong>
  Arcadia is a fictional country and this is not a real regulator. This page exists so that Vouch
  can demonstrate scraper breakage and repair against a target it is permitted to change.
  Every notice below is invented. Nothing here is safety information.
</div>`.trim();

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const longDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  return `${d} ${months[m - 1]} ${y}`;
};

// --- record templates -------------------------------------------------------

// Baseline: flat dl, class-based hooks, ISO dates.
const recordBaseline = (r) => `
    <li class="recall-card" data-recall-id="${esc(r.ref)}">
      <div class="recall-card__ref ref">Reference ${esc(r.ref)}</div>
      <h3 class="recall-card__title">${esc(r.title)}</h3>
      <dl class="recall-meta">
        <dt>Brand</dt><dd class="recall-meta__brand">${esc(r.brand)}</dd>
        <dt>Hazard</dt><dd class="recall-meta__hazard">${esc(r.hazard)}</dd>
        <dt>Risk level</dt><dd class="recall-meta__risk risk" data-level="${esc(r.risk)}">${esc(r.risk)}</dd>
        <dt>Category</dt><dd class="recall-meta__category">${esc(r.category)}</dd>
        <dt>Batch codes</dt><dd class="recall-meta__batch">${esc(r.batch)}</dd>
        <dt>Published</dt><dd class="recall-meta__date">${esc(r.published)}</dd>
        <dt>Action</dt><dd class="recall-meta__action">${esc(r.action)}</dd>
      </dl>
    </li>`;

// Redesign: every class hook renamed, risk wrapped in a nested span behind a
// data-testid, date switched to long form, batch label reworded.
const recordRedesign = (r) => `
    <li class="rc-item" data-notice-ref="${esc(r.ref)}">
      <div class="rc-item__meta-ref ref">Reference ${esc(r.ref)}</div>
      <h3 class="rc-item__heading">${esc(r.title)}</h3>
      <dl class="rc-detail">
        <dt>Brand</dt><dd data-testid="brand">${esc(r.brand)}</dd>
        <dt>Hazard</dt><dd data-testid="hazard-desc">${esc(r.hazard)}</dd>
        <dt>Risk level</dt><dd class="rc-detail__risk"><span data-testid="risk-band" data-level="${esc(r.risk)}">${esc(r.risk)}</span></dd>
        <dt>Category</dt><dd data-testid="product-category">${esc(r.category)}</dd>
        <dt>Affected units</dt><dd data-testid="affected-units">${esc(r.batch)}</dd>
        <dt>Published</dt><dd data-testid="publish-date">${esc(longDate(r.published))}</dd>
        <dt>Action</dt><dd data-testid="consumer-action">${esc(r.action)}</dd>
      </dl>
    </li>`;

// --- page assembly ---------------------------------------------------------

function page({ records, pageNum, pageCount, total, shown, renderRecord, listClass }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Product recalls and safety notices — ${esc(data.authority)} (TEST FIXTURE)</title>
  <style>
${CSS}
  </style>
</head>
<body>

${BANNER}

<header class="site">
  <div class="crest">${esc(data.authority)}</div>
  <div class="dept">${esc(data.directorate)}</div>
</header>

<main>
  <h1>Product recalls and safety notices</h1>
  <p class="lede">Recalls, corrective actions and import refusals published by the Authority.</p>
  <p class="result-count">${total} notices. Showing ${shown}.</p>

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
  baseline: { renderRecord: recordBaseline, listClass: "recall-list", records: data.records },
  redesign: { renderRecord: recordRedesign, listClass: "rc-list", records: data.records },
  // Notice APS-2026-0415 is withdrawn: gone from the listing, not merely restyled.
  withdrawn: {
    renderRecord: recordBaseline,
    listClass: "recall-list",
    records: data.records.filter((r) => r.ref !== "APS-2026-0415"),
  },
};

function build(name) {
  const v = VARIANTS[name];
  if (!v) throw new Error(`unknown variant: ${name}. known: ${Object.keys(VARIANTS).join(", ")}`);

  const outDir = join(here, "dist", name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

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
  }

  console.log(`built ${name}: ${total} notices across ${pageCount} page(s) -> fixtures/dist/${name}/`);
}

const requested = process.argv.slice(2);
(requested.length ? requested : Object.keys(VARIANTS)).forEach(build);

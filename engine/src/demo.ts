// The four causes, replayed offline, so anyone can watch the decision get made.
//
//   npm run demo
//
// The engine's whole argument is that two of the four reasons a field goes null must
// never be repaired. That argument is only worth anything if you can watch it happen,
// and until now watching it required a Bright Data account, a live collector, and a
// fixture site you could break on cue. This runs the same `runCycle` against recorded
// responses instead.
//
// It is a replay, not a reimplementation. Every scenario below calls the real
// `runCycle` with the real contract and the real classifier, and only the four network
// dependencies are pre-recorded. Nothing here decides anything; the engine does. If you
// change `classify.ts` and get the answer wrong, this prints the wrong answer, which is
// the property that makes it worth shipping rather than a transcript.
//
// The recordings are shaped after the live runs written up in `runs/timing.log`. They
// are labelled REPLAY in the output, because a demo that could be mistaken for a live
// run is exactly the kind of thing this project exists to complain about.

import { TRADEWELL_CONTRACT } from "./sources/tradewell.js";
import { runCycle, type CycleDeps, type Row, type SourceState } from "./runner.js";

// --- the recorded world ------------------------------------------------------

const BASE = "https://tradewell-market.example/";

function listing(id: string, title: string): Row {
  return {
    id,
    permalink: `${BASE}item/${id}.html`,
    title,
    brand: title.split(" ")[0] ?? "Brand",
    price: 34,
    condition: "New",
    location: "Boise, ID",
    listedOn: "2026-07-30",
  } as unknown as Row;
}

const CATALOGUE = [
  listing("TW-22765", "Cooluli Classic 15 litre mini-fridge, white"),
  listing("TW-33887", "Zimtown 5 gal portable gas can, red, with spout"),
  listing("TW-44903", "DUMOS 9-drawer fabric TV dresser, grey"),
  listing("TW-55118", "Deli 20L metal jerry can, dark green"),
  listing("TW-66420", "MGC 5x5 magnetic speed cubes, stickerless"),
  listing("TW-77301", "Cooluli Infinity 10L mini fridge, black"),
  listing("TW-88214", "Commowner electric pressure washer, orange"),
  listing("TW-91004", "Northline 40L hiking pack, forest green"),
  listing("TW-91011", "Harbor & Oak 10-inch cast iron skillet"),
  listing("TW-91028", "Pellmore dreadnought acoustic, natural finish"),
  listing("TW-91035", "Field & Wick merino throw, oatmeal"),
  listing("TW-91042", "Kestrel 700c road frame, 56cm"),
  listing("TW-91059", "Marlow ceramic table lamp, sage glaze"),
  listing("TW-91066", "Ridgeform trail runners, slate"),
];

const refOf = (row: Row): string => String((row as Record<string, unknown>).id ?? "");
const ALL_REFS = CATALOGUE.map(refOf);

const INTERSTITIAL =
  "<html><body><h1>Checking your browser</h1>" +
  "<p>Please verify you are a human to continue.</p></body></html>";

const PAGE = "<html><body><ul class='result-list'>" + "<li class='card'></li>".repeat(7) + "</ul></body></html>";

/** A healthy baseline: everything extracted, nothing withdrawn. */
function baseline(): SourceState {
  return {
    baselineRefs: ALL_REFS,
    baselineRows: CATALOGUE.length,
    lastVerifiedAt: "2026-08-18T08:00:00.000Z",
    lastGoodRows: CATALOGUE,
    healHistory: [],
    withdrawnRefs: [],
    streak: null,
    cooldownUntil: null,
  };
}

interface Recording {
  /** What the listing page returns before extraction. */
  probe: { status: number; body: string };
  /** What the collector extracts. */
  rows: Row[];
  /** Which refs still resolve at their own URL. Everything else 404s. */
  liveRefs: string[];
  /** Whether the repair, if one is attempted, succeeds. */
  heal?: { ok: boolean; status: string; durationMs: number; rowsAfter: Row[] };
  state?: SourceState;
}

function deps(rec: Recording, clock: { t: number }): CycleDeps {
  let healed = false;
  return {
    async probeListing() {
      return {
        status: rec.probe.status,
        bodyBytes: rec.probe.body.length,
        blockSignature: /checking your browser|verify you are a human/i.test(rec.probe.body)
          ? "checking your browser"
          : null,
        body: rec.probe.body,
      };
    },
    async runScraper() {
      clock.t += 4_000;
      const rows = healed && rec.heal ? rec.heal.rowsAfter : rec.rows;
      return { rows, errors: [] };
    },
    async probePermalinks(entries) {
      clock.t += 900;
      return entries.map((e) => ({
        ref: e.ref,
        url: e.url,
        status: rec.liveRefs.includes(e.ref) ? 200 : 404,
      }));
    },
    async heal() {
      const h = rec.heal ?? { ok: false, status: "heal_call_failed", durationMs: 0, rowsAfter: [] };
      clock.t += h.durationMs;
      healed = h.ok;
      return { ok: h.ok, durationMs: h.durationMs, status: h.status };
    },
    observeMarkup(body) {
      return {
        listingStatus: 200,
        listingBytes: body.length,
        deadSelectors: [".permalink"],
        observedHooks: ["data-testid", "data-listing-ref"],
        observedLabels: ["Brand", "Item condition", "Location", "Listed"],
      };
    },
    now: () => new Date(clock.t),
  };
}

// --- the scenarios -----------------------------------------------------------

interface Scenario {
  name: string;
  what: string;
  /** What a healer with no classifier would have done, and what it would have cost. */
  naive: string;
  rec: Recording;
}

const SURVIVORS = CATALOGUE.filter((r) => !["TW-88214", "TW-44903", "TW-33887"].includes(refOf(r)));

const SCENARIOS: Scenario[] = [
  {
    name: "gone",
    what: "Three listings were taken down at source. Their own URLs now 404.",
    naive:
      "rewrite the selectors until three rows come back, publishing a recall for products nobody is selling",
    rec: {
      probe: { status: 200, body: PAGE },
      rows: SURVIVORS,
      liveRefs: SURVIVORS.map(refOf),
    },
  },
  {
    name: "blocked",
    what: "An anti-bot interstitial served at HTTP 200. The page looks fine to a status check.",
    naive: "read the challenge page as the new markup and heal against it, deepening the block",
    rec: {
      probe: { status: 200, body: INTERSTITIAL },
      rows: [],
      liveRefs: ALL_REFS,
    },
  },
  {
    name: "pagination",
    what:
      "A redesign broke paging. Seven of fourteen rows returned, and all seven missing records still answer at their own URLs.",
    naive: "nothing wrong with healing here, and the engine agrees",
    rec: {
      probe: { status: 200, body: PAGE },
      rows: CATALOGUE.slice(0, 7),
      liveRefs: ALL_REFS,
      heal: { ok: true, status: "done", durationMs: 330_600, rowsAfter: CATALOGUE },
    },
  },
  {
    name: "drift, repair rejected",
    what:
      "Fields moved. The repair reported success and the collector still returned nothing, which is what the vendor's own 'done' is worth.",
    naive: "trust status: done and serve whatever came back",
    rec: {
      probe: { status: 200, body: PAGE },
      rows: [],
      liveRefs: ALL_REFS,
      heal: { ok: true, status: "done", durationMs: 246_455, rowsAfter: [] },
    },
  },
  {
    name: "resurrected",
    what:
      "A recalled product published as withdrawn is on sale again. Nothing is broken and the contract passes.",
    naive: "serve it as an ordinary listing and say nothing, because nothing failed",
    rec: {
      // The live run saw 12 rows against a baseline of 11: three products had been
      // delisted and one came back. Replaying 14 against 11 would have been a tidier
      // story and a different event from the one runs/timing.log records.
      probe: { status: 200, body: PAGE },
      rows: [...SURVIVORS, CATALOGUE.find((r) => refOf(r) === "TW-33887")!],
      liveRefs: ALL_REFS,
      state: { ...baseline(), baselineRefs: SURVIVORS.map(refOf), baselineRows: SURVIVORS.length,
               lastGoodRows: SURVIVORS, withdrawnRefs: ["TW-33887"] },
    },
  },
];

// --- output ------------------------------------------------------------------

const BOLD = "[1m";
const DIM = "[2m";
const OFF = "[0m";
const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";

const plain = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const c = (code: string, s: string): string => (plain ? s : `${code}${s}${OFF}`);

function rule(): void {
  console.log(c(DIM, "─".repeat(78)));
}

async function main(): Promise<void> {
  console.log("");
  console.log(c(BOLD, "  Vouch: the four causes, and which two are repairable"));
  console.log(
    c(DIM, "  REPLAY of recorded responses. No network, no API key. The classifier,")
  );
  console.log(
    c(DIM, "  the contract and the cycle are the real ones; only the four network")
  );
  console.log(c(DIM, "  dependencies are pre-recorded. See runs/timing.log for the live runs."));
  console.log("");

  let refusals = 0;
  let repairs = 0;
  let served = 0;

  for (const s of SCENARIOS) {
    rule();
    console.log(`  ${c(BOLD, s.name.toUpperCase())}`);
    console.log(`  ${s.what}`);
    console.log("");

    const clock = { t: Date.parse("2026-08-18T09:00:00.000Z") };
    const state = s.rec.state ?? baseline();
    const result = await runCycle(
      {
        sourceId: "tradewell",
        collectorId: "c_demo",
        url: BASE,
        contract: TRADEWELL_CONTRACT,
        state,
        permalinkFor: (ref) => `${BASE}item/${ref}.html`,
        refOf,
        rowsPerPage: 7,
      },
      deps(s.rec, clock)
    );

    const { report, diagnosis, incident, serving } = result;
    // When a repair ran, `report` is the re-measurement, because that is the number the
    // engine gates serving on. Show the extraction that triggered the diagnosis too,
    // otherwise the pagination case reads as "14 rows, contract passed" and the reader
    // never sees the failure that started it.
    const healRan = incident !== null && incident.healAttempted;
    const first = s.rec.rows.length;
    console.log(
      `  extracted        ${first} row(s)` +
        (state.baselineRows !== null ? ` against a baseline of ${state.baselineRows}` : "")
    );
    if (!healRan) {
      console.log(
        `  contract         ${report.passed ? c(GREEN, "passed") : c(RED, "FAILED")}` +
          (report.breaches.length > 0 ? c(DIM, `  (${report.breaches.length} breach(es))`) : "")
      );
    } else {
      console.log(`  contract         ${c(RED, "FAILED")}`);
    }
    console.log(`  diagnosis        ${c(BOLD, diagnosis.cause)}`);
    for (const line of diagnosis.evidence) console.log(c(DIM, `                   ${line}`));

    // Order matters, and it is the same order the feed uses. A repair that ran and was
    // thrown out on measurement carries a refusal string, but it is not a refusal to
    // repair: it is a refusal to publish. Testing the refusal first collapses the most
    // interesting outcome into the least interesting one.
    if (incident !== null && incident.healAttempted) {
      repairs += 1;
      if (incident.verified) served += 1;
      console.log("");
      console.log(
        `  ${c(YELLOW, "REPAIRED")}  in ${((incident.healDurationMs ?? 0) / 1000).toFixed(1)}s`
      );
      console.log(
        `  re-measured      ${report.rows} row(s), contract ` +
          (incident.verified ? c(GREEN, "passed") : c(RED, "still FAILED"))
      );
      if (!incident.verified) {
        console.log(`  ${c(RED, "RESULT REJECTED, NOT SERVED")}`);
        console.log(`  ${c(RED, incident.refusal ?? "")}`);
        console.log(c(DIM, `  a healer without this step would: ${s.naive}`));
      } else {
        console.log(c(DIM, `  the vendor said "done" before this run. That is not evidence.`));
      }
    } else if (incident !== null && incident.refusal !== null) {
      refusals += 1;
      console.log("");
      console.log(`  ${c(RED, "REFUSED TO REPAIR")}`);
      console.log(`  ${c(RED, incident.refusal)}`);
      console.log(c(DIM, `  a healer without this step would: ${s.naive}`));
    } else if (incident !== null && incident.cause === "resurrected") {
      console.log("");
      console.log(`  ${c(BOLD, "BACK ON SALE")}  ${incident.resurrectedRefs.join(", ")}`);
      console.log(c(DIM, `  nothing broke, so a supervisor that only watches for breakage`));
      console.log(c(DIM, `  would: ${s.naive}`));
    }

    console.log("");
    console.log(
      `  serving          ${serving.rows.length} row(s) as ${c(BOLD, serving.state)}`
    );
    console.log("");
  }

  rule();
  console.log("");
  console.log(
    `  ${c(BOLD, String(repairs))} repair(s) attempted, ${c(BOLD, String(served))} survived ` +
      `measurement and was served. ${c(BOLD, String(refusals))} repairs refused outright.`
  );
  console.log(c(DIM, "  The refusals are the product. So is the repair that was thrown away."));
  console.log(
    c(DIM, "  Flip the `gone` branch in src/classify.ts to healable and ten tests fail.")
  );
  console.log("");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

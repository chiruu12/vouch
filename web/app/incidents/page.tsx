// The incident log.
//
// This page is the argument. Every other self-healing scraper has a heal log;
// the interesting column here is the one that says we did not heal, and why.
// The evidence is the classifier's own sentences, unedited, so a reader can
// disagree with the verdict on the same information the engine had.
//
// Incidents caused by our own mistakes are included. One of the four below is
// a heal we should never have started, caught by the gate that checks a repair
// before serving it. Leaving it out would make the log a brochure.

import { Evidence, Figure, Machine } from "../../components/parts";
import { outcome, seconds, snapshot, stamp, type PubIncident } from "../../lib/data";

export const metadata = {
  title: "Incident log",
  description: "Every failure the supervisor recorded, and whether it repaired it or refused.",
};

const CAUSE_MEANING: Record<string, string> = {
  blocked:
    "the request was refused at the door. Rewriting selectors cannot clear a block, so attempting a repair would burn credits and can deepen the block.",
  gone: "the records were removed at source and their permalinks no longer resolve. A repair here fabricates replacements for records somebody deliberately took down.",
  drift: "the data is still published in a different shape. This class of failure is repairable, so a repair was attempted.",
  pagination: "the listing is intact and the paging scheme moved. Repairable.",
  resurrected:
    "a record we published as withdrawn is on sale again. Nothing broke and the contract passed, which is exactly why this used to pass in silence. It is the only entry here that is not a failure.",
  healthy: "nothing was wrong.",
};

function Incident({ i }: { i: PubIncident }) {
  const refused = i.refusal !== null;
  const out = outcome(i);
  return (
    <li className="incident" data-refused={refused} id={i.id}>
      <div className="incident-top">
        <span className="cause">{i.cause}</span>
        <span className="verdict" data-kind={out.kind}>
          {out.label}
        </span>
        <span className="ref">
          {i.sourceLabel} · opened {stamp(i.openedAt)}
        </span>
        <a className="anchor" href={`#${i.id}`} aria-label={`Link to incident ${i.id}`}>
          #
        </a>
      </div>

      <p className="attached-why" style={{ maxWidth: "68ch" }}>
        {CAUSE_MEANING[i.cause] ?? ""}
      </p>

      <div>
        <p className="sub">What the contract measured</p>
        <div className="source-meta">
          {i.rows} rows extracted · {i.breaches.length} contract breach
          {i.breaches.length === 1 ? "" : "es"}
          {i.mttrMs !== null ? ` · time to resolution ${seconds(i.mttrMs)}` : " · unresolved"}
          {i.withdrawnRefs.length > 0 ? ` · withdrawn: ${i.withdrawnRefs.join(", ")}` : ""}
          {i.resurrectedRefs.length > 0 ? ` · back on sale: ${i.resurrectedRefs.join(", ")}` : ""}
        </div>
      </div>

      <div>
        <p className="sub">Evidence, verbatim</p>
        <Evidence lines={i.evidence} />
      </div>

      {refused ? (
        <div>
          <p className="sub">What we declined to do</p>
          <Machine tone="refusal" label="Refusal, recorded verbatim">
            {i.refusal ?? ""}
          </Machine>
        </div>
      ) : null}

      {i.healAttempted ? (
        <div>
          <p className="sub">
            Repair prompt sent to the collector
            {i.healDurationMs !== null ? ` · took ${seconds(i.healDurationMs)}` : ""}
          </p>
          {/* A repair that ran without a recorded prompt is a gap in our own record,
              and an empty sunken mono block would render it as a device that measured
              nothing. Absence gets said in words, the same as everywhere else. */}
          {i.prompt === null ? (
            <p className="absent">this repair ran before the prompt was recorded</p>
          ) : (
            <Machine label="Verbatim">{i.prompt}</Machine>
          )}
        </div>
      ) : null}

      {/* Rendered in full, not behind a disclosure: these are the numbers the
          verdict rests on, and a hidden breach is a hidden argument. */}
      {i.breaches.length > 0 ? (
        <div>
          <p className="sub">All {i.breaches.length} contract breaches, verbatim</p>
          <Evidence lines={i.breaches} />
        </div>
      ) : null}
    </li>
  );
}

export default function Page() {
  const snap = snapshot();
  const incidents = [...snap.incidents].reverse();
  // A deferral is not a refusal. See the snapshot builder for why that
  // distinction is worth the extra clause.
  const declined = incidents.filter((i) => i.refusal !== null && !i.healDeferred);
  const attempted = incidents.filter((i) => i.healAttempted);
  const served = attempted.filter((i) => i.verified).length;

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Incident log</p>
        <h1 className="page">Every failure, and whether we repaired it</h1>
        <p className="lede">
          A scraper that repairs everything it cannot read will eventually invent a safety
          recall. Two of the four failure causes here must never be repaired, and the log
          records the refusal rather than the silence. Newest first.
        </p>
      </header>

      <div className="figures" role="group" aria-label="Incident log at a glance">
        <Figure value={incidents.length} label="incidents recorded" />
        <Figure value={declined.length} label="times the engine declined" emphasis="refusal" />
        <Figure value={`${served}/${attempted.length}`} label="repairs attempted that survived measurement" />
        <Figure
          value={incidents.reduce((n, i) => n + i.withdrawnRefs.length, 0)}
          label="records removed at source, kept as history"
        />
      </div>

      <section className="block" aria-labelledby="timeline-h">
        <div className="section-head">
          <h2 className="section" id="timeline-h">
            Timeline
          </h2>
          <p className="section-note">
            Each entry shows what the contract measured, the classifier&rsquo;s evidence word
            for word, and either the refusal or the prompt that was sent. The prompt is
            included in full because a repair instruction is the part of a self-healing
            scraper nobody normally lets you read.
          </p>
        </div>
        <ol className="timeline">
          {incidents.map((i) => (
            <Incident i={i} key={i.id} />
          ))}
        </ol>
      </section>

      <footer className="foot">
        <p>
          The oldest entry is our own fault and is kept for that reason. A source adapter was
          reused for the wrong collector, every field read as null, and the engine started a
          repair on a scraper that was working correctly. The repair finished, the contract
          still failed, and the gate refused to serve the result. The bug cost four minutes
          of credits; without the gate it would have cost the feed its accuracy.
        </p>
      </footer>
    </>
  );
}

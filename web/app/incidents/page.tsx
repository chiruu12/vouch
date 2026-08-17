// The incident log.
//
// This page is the argument. Every other self-healing scraper has a heal log; the
// interesting column here is the one that says we did not heal, and why. The evidence
// is the classifier's own sentences, unedited, so a reader can disagree with the
// verdict on the same information the engine had.
//
// Incidents caused by our own mistakes are included. One of the four below is a heal
// we should never have started, caught by the gate that checks a repair before serving
// it. Leaving it out would make the log a brochure.

import { Evidence, Machine } from "../../components/parts";
import { seconds, snapshot, stamp, type PubIncident } from "../../lib/data";

const CAUSE_MEANING: Record<string, string> = {
  blocked:
    "the request was refused at the door. Rewriting selectors cannot clear a block, so attempting a repair would burn credits and can deepen the block.",
  gone: "the records were removed at source and their permalinks no longer resolve. A repair here fabricates replacements for records somebody deliberately took down.",
  drift: "the data is still published in a different shape. This class of failure is repairable, so a repair was attempted.",
  pagination: "the listing is intact and the paging scheme moved. Repairable.",
  healthy: "nothing was wrong.",
};

/** Three outcomes, not two. Refusing to start a repair and throwing away a repair that
 *  finished are different events, and collapsing them into "refused" hid the more
 *  interesting one: a repair that reported success and was rejected on measurement. */
function outcome(i: PubIncident): { label: string; kind: "refused" | "healed" } {
  if (i.verified && i.healAttempted) return { label: "repaired and verified", kind: "healed" };
  if (i.healAttempted) return { label: "repair ran, result rejected", kind: "refused" };
  if (i.refusal !== null) return { label: "repair refused", kind: "refused" };
  return { label: "no repair needed", kind: "healed" };
}

function Incident({ i }: { i: PubIncident }) {
  const refused = i.refusal !== null;
  const out = outcome(i);
  return (
    <li className="incident" data-refused={refused}>
      <div className="incident-top">
        <span className="cause">{i.cause}</span>
        <span className="verdict" data-kind={out.kind}>
          {out.label}
        </span>
        <span className="ref">
          {i.sourceLabel} · opened {stamp(i.openedAt)}
        </span>
      </div>

      <p className="attached-why" style={{ maxWidth: "68ch" }}>
        {CAUSE_MEANING[i.cause] ?? ""}
      </p>

      <div>
        <p className="sub">What the contract measured</p>
        <div className="source-meta" style={{ marginTop: "0.3rem" }}>
          {i.rows} rows extracted · {i.breaches.length} contract breach
          {i.breaches.length === 1 ? "" : "es"}
          {i.mttrMs !== null ? ` · time to resolution ${seconds(i.mttrMs)}` : " · unresolved"}
          {i.withdrawnRefs.length > 0 ? ` · withdrawn: ${i.withdrawnRefs.join(", ")}` : ""}
        </div>
      </div>

      <div>
        <p className="sub">Evidence, verbatim</p>
        <Evidence lines={i.evidence} />
      </div>

      {refused ? (
        <div>
          <p className="sub">Refusal</p>
          <Machine tone="refusal">{i.refusal ?? ""}</Machine>
        </div>
      ) : null}

      {i.healAttempted ? (
        <div>
          <p className="sub">
            Repair prompt sent to the collector
            {i.healDurationMs !== null ? ` · took ${seconds(i.healDurationMs)}` : ""}
          </p>
          <Machine>{i.prompt ?? ""}</Machine>
        </div>
      ) : null}

      {i.breaches.length > 0 ? (
        <details>
          <summary className="sub" style={{ cursor: "pointer" }}>
            All {i.breaches.length} contract breaches
          </summary>
          <div style={{ marginTop: "0.5rem" }}>
            <Evidence lines={i.breaches} />
          </div>
        </details>
      ) : null}
    </li>
  );
}

export default function Page() {
  const snap = snapshot();
  const incidents = [...snap.incidents].reverse();
  const refusals = incidents.filter((i) => i.refusal !== null).length;
  const healed = incidents.filter((i) => i.healAttempted).length;

  return (
    <>
      <header>
        <p className="eyebrow">Incident log</p>
        <h1 className="page">Every failure, and whether we repaired it</h1>
        <p className="lede">
          A scraper that repairs everything it cannot read will eventually invent a safety
          recall. Two of the four failure causes here must never be repaired, and the log
          records the refusal rather than the silence. Newest first.
        </p>
      </header>

      <div className="figures">
        <div className="figure">
          <b>{incidents.length}</b>
          <span>incidents recorded</span>
        </div>
        <div className="figure" data-emphasis="refusal">
          <b>{refusals}</b>
          <span>repairs refused</span>
        </div>
        <div className="figure">
          <b>{healed}</b>
          <span>repairs attempted{healed > 0 ? ", none served" : ""}</span>
        </div>
        <div className="figure">
          <b>{incidents.reduce((n, i) => n + i.withdrawnRefs.length, 0)}</b>
          <span>records removed at source, kept as history</span>
        </div>
      </div>

      <section>
        <div className="section-head">
          <h2 className="section">Timeline</h2>
          <p className="section-note">
            Each entry shows what the contract measured, the classifier&rsquo;s evidence word for
            word, and either the refusal or the prompt that was sent. The prompt is included in
            full because a repair instruction is the part of a self-healing scraper nobody
            normally lets you read.
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
          still failed, and the gate refused to serve the result. The bug cost four minutes of
          credits; without the gate it would have cost the feed its accuracy.
        </p>
      </footer>
    </>
  );
}

// The feed.
//
// The page splits on a single question: did we find this product on sale
// anywhere we watch? That is the only thing here a reader can act on, and
// rendering all eighteen notices as equal-weight cards buried the three that
// mattered under fifteen that did not. The rest stay on the page in full,
// compactly, because dropping them would misrepresent how much the feed holds.
//
// The refusals sit above the recall list, not behind the incident log. A feed
// whose argument is "we decline to publish" should decline on the front page.

import { Figure, ListingRow, Machine, Provenance, Severity, Trust } from "../components/parts";
import { dateOnly, outcome, snapshot, stamp, type PubRecall } from "../lib/data";

const RISK_ORDER: Record<string, number> = {
  Serious: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Unknown: 4,
};

const hasReturn = (r: PubRecall): boolean => r.onSale.some((l) => l.resurrected !== undefined);

function byRisk(a: PubRecall, b: PubRecall): number {
  // A recalled product that was taken down and put back outranks everything, whatever
  // its risk band. The band is the source's judgement about the product; a return to
  // sale after a withdrawal is a fact about right now, and it is the reason a reader
  // who already saw this feed yesterday should look at it again today.
  const back = Number(hasReturn(b)) - Number(hasReturn(a));
  if (back !== 0) return back;
  const risk = (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9);
  if (risk !== 0) return risk;
  return (b.published ?? "").localeCompare(a.published ?? "");
}

function Recall({ r, threshold }: { r: PubRecall; threshold: number }) {
  return (
    <article className="card" data-risk={r.risk}>
      <div className="card-top">
        <Severity risk={r.risk} />
        <span className="ref">{r.ref}</span>
        <span className="gap" />
        <span className="ref">{r.provenance.sourceLabel}</span>
      </div>

      <h3>
        {r.permalink === null ? (
          r.title
        ) : (
          <a href={r.permalink} rel="noreferrer">
            {r.title}
          </a>
        )}
      </h3>

      {/* The fact list is a fixed schema, not a list of whatever the source happened
          to publish. Dropping a row when a field is null put two conventions on one
          card: brand said "not stated" while category vanished, so a reader could not
          tell an unpublished field from one the feed never asked for. */}
      {r.hazard === null ? (
        <p className="absent">hazard not stated by source</p>
      ) : (
        <p className="hazard">{r.hazard}</p>
      )}

      <dl className="facts">
        <div>
          <dt>Brand</dt>
          <dd>{r.brand ?? "not stated"}</dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>{dateOnly(r.published)}</dd>
        </div>
        <div>
          <dt>Affected units</dt>
          <dd>{r.affectedUnits ?? "not stated"}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{r.category ?? "not stated"}</dd>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <dt>What to do</dt>
          <dd>{r.action ?? "no remedy published by source"}</dd>
        </div>
      </dl>

      {r.onSale.length === 0 ? null : (
        <div className="attached" data-kind="onsale">
          <div className="attached-head">
            <span className="attached-title">
              Same product line, currently listed ({r.onSale.length})
            </span>
          </div>
          <p className="attached-why">
            The listing is for this product line. Whether the individual unit falls inside
            the recalled batch cannot be established from a listing, and is not claimed.
          </p>
          {r.onSale.map((l) => (
            <ListingRow listing={l} key={l.id} />
          ))}
          <Provenance p={r.onSale[0]!.provenance} attached />
        </div>
      )}

      {r.quarantined.length === 0 ? null : (
        <div className="attached" data-kind="held">
          <div className="attached-head">
            <span className="attached-title">Held back, not asserted ({r.quarantined.length})</span>
          </div>
          <p className="attached-why">
            These looked close enough to check and did not clear the bar. They are shown with
            the reason rather than dropped, because a silently discarded near-miss looks the
            same as never having looked.
          </p>
          {r.quarantined.map((l) => (
            <ListingRow listing={l} threshold={threshold} key={l.id} />
          ))}
          <Provenance p={r.quarantined[0]!.provenance} attached />
        </div>
      )}

      <Provenance p={r.provenance} />
    </article>
  );
}

export default function Page() {
  const snap = snapshot();

  const active = snap.recalls.filter((r) => r.onSale.length > 0 || r.quarantined.length > 0).sort(byRisk);
  const quiet = snap.recalls.filter((r) => r.onSale.length === 0 && r.quarantined.length === 0).sort(byRisk);
  // A deferral carries a refusal string but is not one: the repair was not
  // declined, it was not allowed to start. The distinction is the snapshot's
  // own, and the front page inherits it rather than recounting.
  const refusals = snap.incidents.filter((i) => i.refusal !== null && !i.healDeferred);
  // Not all of these are refusals to repair. One is a repair that ran, reported done,
  // and was rejected on measurement, which is a refusal to publish. Counting them under
  // one word made the strongest entry in the log read as the weakest.
  const declinedToStart = refusals.filter((i) => !i.healAttempted).length;
  const rejectedResult = refusals.filter((i) => i.healAttempted).length;
  const returned = snap.recalls.reduce(
    (n, r) => n + r.onSale.filter((l) => l.resurrected !== undefined).length,
    0
  );

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Product safety feed</p>
        <h1 className="page">Recalled products, and where they are still on sale</h1>
        <p className="lede">
          {snap.totals.recalls} recall notices cross-checked against the{" "}
          {snap.totals.listingsWatched} marketplace listings we watch. Every record states how
          it was fetched and when it was last verified, and when the source breaks in a way
          that cannot be honestly repaired the feed says so instead of filling the gap.
        </p>
        <p className="stamp-line">snapshot published {stamp(snap.generatedAt)}</p>
      </header>

      <div className="figures" role="group" aria-label="This snapshot at a glance">
        <Figure value={snap.totals.recalls} label="recall notices held" />
        <Figure value={snap.totals.asserted} label="asserted as the same product line, still listed" />
        <Figure value={snap.totals.quarantined} label="close match held back, reason shown" />
        <Figure value={snap.totals.withdrawn} label="removed at source, kept as history" />
        {returned === 0 ? null : (
          <Figure value={returned} label="withdrawn, then back on sale" emphasis="return" />
        )}
        <Figure value={snap.totals.refusals} label="times the engine declined, on record" emphasis="refusal" />
      </div>

      {refusals.length === 0 ? null : (
        <section className="block" aria-labelledby="refusals-h">
          <div className="section-head">
            <h2 className="section" id="refusals-h">
              Declined, on record
            </h2>
            <p className="section-note">
              {declinedToStart} times the engine refused to attempt a repair, and{" "}
              {rejectedResult} times it threw away a repair that finished and still failed the
              contract. A healer that always answers will eventually invent a safety recall, so
              each decision is recorded and published with the evidence that produced it. The{" "}
              <a href="/incidents">incident log</a> holds every one in full.
            </p>
          </div>
          {refusals.map((i) => (
            <article className="card" key={i.id}>
              <div className="card-top">
                {/* The same definition the incident log uses. Hardcoding "repair
                    refused" here collapsed a repair that ran and was thrown out on
                    measurement into a repair we declined to start, which is the
                    distinction the log exists to keep. */}
                <span className="verdict" data-kind={outcome(i).kind}>
                  {outcome(i).label}
                </span>
                <span className="cause">{i.cause}</span>
                <span className="ref">
                  {i.sourceLabel} · opened {stamp(i.openedAt)}
                </span>
                <span className="gap" />
                <a className="ref" href={`/incidents#${i.id}`}>
                  incident record
                </a>
              </div>
              <Machine tone="refusal" label="Refusal, verbatim">
                {i.refusal ?? ""}
              </Machine>
            </article>
          ))}
        </section>
      )}

      <section className="block" aria-labelledby="onsale-h">
        <div className="section-head">
          <h2 className="section" id="onsale-h">
            Found on sale
          </h2>
          <p className="section-note">
            {active.length} of {snap.totals.recalls} notices have something attached across the{" "}
            {snap.totals.listingsWatched} listings we watch: {snap.totals.asserted} asserted as
            the same product line, {snap.totals.quarantined} held back with the reason shown.
          </p>
        </div>
        <p className="notice">{snap.caveat}</p>
        {active.map((r) => (
          <Recall r={r} threshold={snap.publishThreshold} key={`${r.provenance.sourceId}-${r.ref}`} />
        ))}
      </section>

      {snap.withdrawn.length === 0 ? null : (
        <section className="block" aria-labelledby="withdrawn-h">
          <div className="section-head">
            <h2 className="section" id="withdrawn-h">
              Withdrawn at source
            </h2>
            <p className="section-note">
              These listings were matched to a recall and have since been removed by the
              marketplace. Their permalinks return 404, so the records are kept as history and
              never regenerated. Repairing the scraper here would have invented replacements
              for listings that were deliberately taken down.
            </p>
          </div>
          <div className="attached" data-kind="held">
            <div className="attached-head">
              <span className="attached-title">
                Removed by the marketplace ({snap.withdrawn.length})
              </span>
              <Trust state="withdrawn" />
            </div>
            {snap.withdrawn.map((l) => (
              <ListingRow listing={l} key={l.id} />
            ))}
            <Provenance p={snap.withdrawn[0]!.provenance} attached />
          </div>
        </section>
      )}

      {quiet.length === 0 ? null : (
        <section className="block" aria-labelledby="quiet-h">
          <div className="section-head">
            <h2 className="section" id="quiet-h">
              Held, nothing found on sale
            </h2>
            <p className="section-note">
              {quiet.length} notices with no match above or below the bar in the listings we
              watch. Coverage is one marketplace, so this means we did not find it, not that it
              is not being sold.
            </p>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Product</th>
                  <th>Risk</th>
                  <th>Published</th>
                  <th>Source</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {quiet.map((r) => (
                  <tr key={`${r.provenance.sourceId}-${r.ref}`}>
                    <td className="mono nowrap">{r.ref}</td>
                    <td style={{ minWidth: "20rem" }}>
                      {r.permalink === null ? (
                        r.title
                      ) : (
                        <a href={r.permalink} rel="noreferrer">
                          {r.title}
                        </a>
                      )}
                      {r.brand === null ? null : <div className="source-meta">{r.brand}</div>}
                    </td>
                    <td className="nowrap">
                      <Severity risk={r.risk} absence="not published" />
                    </td>
                    <td className="num">{dateOnly(r.published)}</td>
                    {/* The source id rather than the full label: the label wrapped to four
                        lines in this column and made every row three times taller than its
                        content. The synthetic marker is the part that has to survive. */}
                    <td className="mono nowrap">
                      {r.provenance.sourceId}
                      {r.provenance.synthetic ? (
                        <div className="source-meta">synthetic fixture</div>
                      ) : null}
                    </td>
                    <td className="nowrap">
                      <Trust state={r.provenance.trust} />
                      <div className="source-meta" style={{ marginTop: "0.25rem" }}>
                        {r.provenance.contractVersion}
                        <br />
                        {stamp(r.provenance.lastVerifiedAt)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="foot">
        <p>
          Arcadia Product Safety and Tradewell Market are synthetic fixtures built for this
          project, so that failure modes can be induced on demand without hammering a real
          regulator. They are labelled as synthetic everywhere they appear. CPSC recalls and
          the eBay measurement on the <a href="/method">method page</a> are real.
        </p>
      </footer>
    </>
  );
}

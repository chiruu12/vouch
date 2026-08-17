// The feed.
//
// The page splits on a single question: did we find this product on sale anywhere we
// watch? That is the only thing here a reader can act on, and rendering all eighteen
// notices as equal-weight cards buried the three that mattered under fifteen that did
// not. The rest stay on the page in full, compactly, because dropping them would
// misrepresent how much the feed holds.

import { ListingRow, Provenance, Trust } from "../components/parts";
import { dateOnly, snapshot, stamp, type PubRecall } from "../lib/data";

const RISK_ORDER: Record<string, number> = {
  Serious: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Unknown: 4,
};

function byRisk(a: PubRecall, b: PubRecall): number {
  const risk = (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9);
  if (risk !== 0) return risk;
  return (b.published ?? "").localeCompare(a.published ?? "");
}

/** CPSC does not publish a risk band in the fields we read, so most real notices have
 *  none. Rendering "Unknown risk" as a severity chip on those made a missing field
 *  look like a measured one. The absence is stated quietly instead. */
function RiskMark({ risk }: { risk: string }) {
  if (risk === "Unknown") return <span className="ref">risk band not published by source</span>;
  return <span className="risk">{risk} risk</span>;
}

function Recall({ r }: { r: PubRecall }) {
  return (
    <article className="card" data-risk={r.risk}>
      <div className="card-top">
        <RiskMark risk={r.risk} />
        <span className="ref">{r.ref}</span>
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

      {r.hazard === null ? null : <p className="hazard">{r.hazard}</p>}

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
        {r.action === null ? null : (
          <div style={{ gridColumn: "1 / -1" }}>
            <dt>What to do</dt>
            <dd>{r.action}</dd>
          </div>
        )}
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
            <ListingRow listing={l} key={l.id} />
          ))}
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

  return (
    <>
      <header>
        <p className="eyebrow">Product safety feed</p>
        <h1 className="page">Recalled products, and where they are still on sale</h1>
        <p className="lede">
          Every record below carries the state of the scraper that produced it and the
          contract that scraper was checked against. When a source breaks in a way that
          cannot be honestly repaired, the feed says so instead of filling the gap. The{" "}
          <a href="/incidents">incident log</a> holds {snap.totals.refusals} refusals in the
          system&rsquo;s own words.
        </p>
      </header>

      <p className="caveat">{snap.caveat}</p>

      <section>
        <div className="section-head">
          <h2 className="section">Found on sale</h2>
          <p className="section-note">
            {active.length} of {snap.totals.recalls} notices have something attached across the{" "}
            {snap.totals.listingsWatched} listings we watch: {snap.totals.asserted} asserted as
            the same product line, {snap.totals.quarantined} held back with the reason shown.
          </p>
        </div>
        {active.map((r) => (
          <Recall r={r} key={`${r.provenance.sourceId}-${r.ref}`} />
        ))}
      </section>

      {snap.withdrawn.length === 0 ? null : (
        <section>
          <div className="section-head">
            <h2 className="section">Withdrawn at source</h2>
            <p className="section-note">
              These listings were matched to a recall and have since been removed by the
              marketplace. Their permalinks return 404, so the records are kept as history and
              never regenerated. Repairing the scraper here would have invented replacements
              for listings that were deliberately taken down.
            </p>
          </div>
          <div className="card">
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
            </div>
          </div>
        </section>
      )}

      {quiet.length === 0 ? null : (
        <section>
          <div className="section-head">
            <h2 className="section">Held, nothing found on sale</h2>
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
                    <td className="nowrap" style={{ fontFamily: "var(--mono)", fontSize: "0.78rem" }}>
                      {r.ref}
                    </td>
                    <td style={{ minWidth: "22rem" }}>
                      {r.permalink === null ? (
                        r.title
                      ) : (
                        <a href={r.permalink} rel="noreferrer">
                          {r.title}
                        </a>
                      )}
                      {r.brand === null ? null : <div className="source-meta">{r.brand}</div>}
                    </td>
                    <td className="nowrap">{r.risk === "Unknown" ? "not published" : r.risk}</td>
                    <td className="num">{dateOnly(r.published)}</td>
                    {/* The source id rather than the full label: the label wrapped to four
                        lines in this column and made every row three times taller than its
                        content. The synthetic marker is the part that has to survive. */}
                    <td className="nowrap" style={{ fontFamily: "var(--mono)", fontSize: "0.78rem" }}>
                      {r.provenance.sourceId}
                      {r.provenance.synthetic ? (
                        <div className="source-meta">synthetic</div>
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

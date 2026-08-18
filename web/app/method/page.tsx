// Method and limits.
//
// The numbers on this page are the ones that could embarrass the project,
// which is why they are on a page of their own rather than folded into a
// summary. 17 publishable matches out of 193 real listings is a low rate. It
// is also the honest rate for a matcher that refuses to name a seller on a
// fuzzy title match, and tuning the fixture until the number flattered us
// would have produced a better demo and a worse system.

import { Figure } from "../../components/parts";
import { snapshot } from "../../lib/data";

export const metadata = {
  title: "Method",
  description: "How a recall is matched to a listing, and why most candidates are held back.",
};

export default function Page() {
  const snap = snapshot();
  const s = snap.study;
  const pct = (n: number) => (s.listings === 0 ? "0%" : `${((n / s.listings) * 100).toFixed(1)}%`);
  const maxReason = Math.max(1, ...s.quarantineReasons.map((q) => q.count));

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">Method and limits</p>
        <h1 className="page">What this feed will not tell you</h1>
        <p className="lede">
          Three claims are available about a recalled product and a marketplace listing, and
          only two of them are honest. This page states which one the feed makes, the measured
          cost of making only that one, and the failure modes that are still open.
        </p>
      </header>

      <section className="block" aria-labelledby="claim-h">
        <div className="section-head">
          <h2 className="section" id="claim-h">
            The claim we make
          </h2>
        </div>
        <div className="prose">
          <p>
            Recalls are usually batch-specific. A notice covers serials 4400 to 6200, or units
            manufactured between two dates. A resale listing almost never shows a lot code, and
            frequently does not show the model.
          </p>
          <p>
            So a title match cannot establish that a listing is a recalled unit. It can
            establish that a listing is for the same product line as a recall. That is a
            materially weaker claim, and it is the only one the feed makes.
          </p>
          <p className="notice">{snap.caveat}</p>
          <h3>What follows from that</h3>
          <ul>
            <li>
              Seller identity is never published. It is hashed at the adapter, before the
              matcher sees it, and the published record type has no field for it. Naming a
              seller as trading recalled goods on a fuzzy title match is the specific lie this
              project exists to avoid.
            </li>
            <li>
              A match below <code>{snap.publishThreshold}</code> confidence is quarantined,
              shown with its reason, and never asserted. The threshold is set high on purpose:
              a false positive here is an accusation and a false negative is only a miss.
            </li>
            <li>
              A listing that states an attribute the recall rules out is demoted below the
              threshold even when the brand and product agree. A 4-litre fridge is not covered
              by a recall of the 10 and 15 litre models, however well the words line up.
            </li>
          </ul>
        </div>
      </section>

      <section className="block" aria-labelledby="study-h">
        <div className="section-head">
          <h2 className="section" id="study-h">
            Measured on a real marketplace
          </h2>
          <p className="section-note">
            {s.recalls} real recalls from {s.recallSource} against {s.listings} real listings
            from {s.listingSource}, captured {s.capturedAt}. One run, reported whole.
          </p>
        </div>

        <div className="figures" role="group" aria-label="Study at a glance">
          <Figure value={s.listings} label="real listings examined" />
          <Figure value={s.publishable} label={`asserted, ${pct(s.publishable)} of listings`} />
          <Figure value={s.quarantined} label={`quarantined, ${pct(s.quarantined)}`} emphasis="refusal" />
          <Figure value={s.unmatched} label="no match at all" />
        </div>

        <div>
          <div
            className="bar"
            role="img"
            aria-label={`Of ${s.listings} listings: ${s.publishable} asserted, ${s.quarantined} quarantined, ${s.unmatched} no match`}
          >
            <span data-seg="publishable" style={{ width: pct(s.publishable) }} />
            <span data-seg="quarantined" style={{ width: pct(s.quarantined) }} />
            <span data-seg="unmatched" style={{ width: pct(s.unmatched) }} />
          </div>
          <ul className="bar-legend">
            <li>
              <i data-seg="publishable" />
              asserted ({s.publishable})
            </li>
            <li>
              <i data-seg="quarantined" />
              quarantined with a stated reason ({s.quarantined})
            </li>
            <li>
              <i data-seg="unmatched" />
              no match ({s.unmatched})
            </li>
          </ul>
        </div>

        <div className="prose">
          <p>
            The rate is low and it is meant to be. {s.quarantined} of {s.matched} matches were
            held back, and the reasons below are checkable rather than a score. Most of them
            are a stated capacity that the recall does not cover, which is exactly the case a
            keyword search gets wrong and reports as a hit.
          </p>
        </div>

        <div>
          <p className="eyebrow">Why each match was held back</p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Reason, as the matcher stated it</th>
                  <th>Listings</th>
                </tr>
              </thead>
              <tbody>
                {s.quarantineReasons.map((q) => (
                  <tr key={q.reason}>
                    <td className="mono">{q.reason}</td>
                    <td className="num">
                      {q.count}
                      <span className="meter" aria-hidden="true">
                        <i style={{ width: `${((q.count / maxReason) * 100).toFixed(1)}%` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <p className="eyebrow">What the confidence rests on</p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Basis</th>
                  <th>Matches</th>
                  <th>What it means</th>
                </tr>
              </thead>
              <tbody>
                {s.byBasis.map((b) => (
                  <tr key={b.basis}>
                    <td className="mono">{b.basis}</td>
                    <td className="num">{b.count}</td>
                    <td>
                      {b.basis === "upc"
                        ? "Identifier agreement. The only basis that identifies a product with certainty, and about 5% of CPSC records carry one."
                        : b.basis === "brand+model"
                          ? "Brand agrees and a model code appears in both. Strong for a product line."
                          : b.basis === "brand+product"
                            ? "Brand agrees and several product nouns overlap. Reasonable for a product line."
                            : "Product nouns overlap with no brand agreement. Not publishable on its own."}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <p className="eyebrow">Worked examples, both directions</p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Verdict</th>
                  <th>Recall</th>
                  <th>Listing</th>
                  <th>Rests on</th>
                </tr>
              </thead>
              <tbody>
                {s.examples.map((e, i) => (
                  <tr key={i}>
                    <td>
                      <span
                        className="verdict"
                        data-kind={e.verdict === "publishable" ? "asserted" : "refused"}
                      >
                        {e.verdict === "publishable" ? "asserted" : "held"}
                      </span>
                      <div className="source-meta" style={{ marginTop: "0.3rem", whiteSpace: "nowrap" }}>
                        {e.confidence.toFixed(2)} {e.basis}
                      </div>
                    </td>
                    <td style={{ minWidth: "16rem" }}>{e.recallTitle}</td>
                    <td style={{ minWidth: "16rem" }}>{e.listingTitle}</td>
                    <td>
                      <div className="basis">
                        {e.matchedTokens.map((t) => (
                          <span className="token" key={t}>
                            {t}
                          </span>
                        ))}
                      </div>
                      {e.contradiction === null ? null : (
                        <p className="clash">clash: {e.contradiction}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="block" aria-labelledby="judged-h">
        <div className="section-head">
          <h2 className="section" id="judged-h">
            How a source is judged
          </h2>
        </div>
        <div className="prose">
          <p>
            Each source has a contract with a version, a minimum row count, a maximum
            row-count drop, and a per-field null-rate and type limit calibrated against an
            observed healthy capture. A run that breaches the contract is diagnosed before
            anything is repaired.
          </p>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Diagnosis</th>
                <th>Evidence used</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">blocked</td>
                <td>
                  A refusal status, or a block signature in a body served at HTTP 200. The
                  dangerous block is the one that does not announce itself with a 4xx.
                </td>
                <td>Back off. Serve the last verified copy, labelled stale.</td>
              </tr>
              <tr>
                <td className="mono">gone</td>
                <td>
                  The record is absent from the listing and its own permalink returns 404 or
                  410. The permalink is the oracle that separates a withdrawal from a read
                  failure.
                </td>
                <td>Never repair. Keep the record, mark it withdrawn.</td>
              </tr>
              <tr>
                <td className="mono">pagination</td>
                <td>Row count lands on one page of the known page size while every missing
                  record still returns 200.
                </td>
                <td>Repair, then verify against the contract before serving.</td>
              </tr>
              <tr>
                <td className="mono">drift</td>
                <td>Fields breached their limits and the missing records are still published.</td>
                <td>Repair, then verify against the contract before serving.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="prose">
          <h3>The gate that matters most</h3>
          <p>
            A repair reporting success is not evidence that it worked. Every repair is followed
            by a fresh run measured against the same contract, and the result is only served
            if that run passes. This has already caught a repair that finished cleanly and
            returned nothing, which is on the <a href="/incidents">incident log</a> as the
            oldest entry.
          </p>
        </div>
      </section>

      <section className="block" aria-labelledby="open-h">
        <div className="section-head">
          <h2 className="section" id="open-h">
            Still open
          </h2>
        </div>
        <div className="prose">
          <ul>
            <li>
              Matching is title-based. It cannot read a lot code off a photo, so batch-level
              certainty is out of reach by construction, not by effort.
            </li>
            <li>
              A record that is withdrawn at source and later reappears sorts above every
              other recall and carries both dates, but nobody is told. There is no
              subscription and no alert, so the feed reports a relisting only to a reader
              who happens to open it.
            </li>
            <li>
              Three collectors in the account are permanently stuck: one on a repair prompt
              that was too aggressive, and two holding a repair lock that outlived the job
              that took it. A repair can damage a working scraper, and nothing here prevents
              that beyond refusing to serve the result.
            </li>
            <li>
              Bright Data cannot run a repaired collector as a draft from the CLI, so the
              verification gate sits at serving time rather than at promotion time. The
              collector can be left in a worse state than it started, even though the feed
              never shows the bad output.
            </li>
            <li>
              Coverage is two recall sources and one marketplace. Nothing here has been
              measured against a regulator that redesigns its site without warning, because
              that has not happened during the build.
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}

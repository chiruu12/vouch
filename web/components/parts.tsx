// Shared pieces. Three of them exist to make a rule structural rather than
// remembered.
//
// `Machine` is the only component that renders text the engine wrote, and it
// always renders it whole. There is no truncating variant, because a shortened
// refusal reads as a softer refusal.
//
// `ListingRow` takes a `PubListing` and cannot be given a seller, because the
// published type has no seller field. The snapshot strips it and the component
// could not display it if the strip failed.
//
// `Severity` renders the risk band as form (a four-segment bar) so that hue on
// this page only ever means a decision the system made, never a measurement.

import type { PubListing } from "../lib/data";
import { dateOnly, money, stamp } from "../lib/data";

export function Trust({ state }: { state: string }) {
  return (
    <span className="badge" data-trust={state}>
      {state}
    </span>
  );
}

/** A synthetic fixture must never be mistakable for a real source, so the tag
 *  is rendered from the flag rather than parsed out of a label string. */
export function SyntheticTag() {
  return <span className="tag">synthetic fixture</span>;
}

/** Risk band as a segmented bar. Where the source publishes no band, the device
 *  is absent and the absence is stated in words, so a missing field never reads
 *  as a measured one. */
export function Severity({ risk, absence }: { risk: string; absence?: string }) {
  if (risk === "Unknown") {
    return <span className="absent">{absence ?? "risk band not published by source"}</span>;
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.55rem" }}>
      <span className="sev" data-level={risk} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="sev-word">{risk} risk</span>
    </span>
  );
}

/** Text the engine produced, quoted verbatim and set in mono so the reader can
 *  see it was not rewritten on the way to the page. */
export function Machine({
  children,
  tone,
  label,
}: {
  children: string;
  tone?: "refusal";
  label?: string;
}) {
  return (
    <div className="machine-wrap">
      {label === undefined ? null : (
        <span className="machine-label" {...(tone !== undefined ? { "data-tone": tone } : {})}>
          {label}
        </span>
      )}
      <p className="machine" {...(tone !== undefined ? { "data-tone": tone } : {})}>
        {children}
      </p>
    </div>
  );
}

export function Evidence({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="evidence">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

export function Provenance({ p }: { p: PubListing["provenance"] }) {
  return (
    <div className="prov">
      <Trust state={p.trust} />
      <span>{p.sourceLabel}</span>
      {p.synthetic ? <SyntheticTag /> : null}
      <span className="sep">{p.scraped ? "scraped" : "publisher API"}</span>
      <span className="sep">contract {p.contractVersion}</span>
      <span className="sep">last verified {stamp(p.lastVerifiedAt)}</span>
      {p.heals > 0 ? <span className="sep">{p.heals} verified heal(s)</span> : null}
    </div>
  );
}

export function ListingRow({ listing }: { listing: PubListing }) {
  const withdrawn = listing.provenance.trust === "withdrawn";
  const m = listing.match;
  // The badge answers "what is this row's status", and inside a quarantine block
  // the answer is "held", not "the scrape that found it was verified". A
  // source-level verified pill here would read as endorsing the match, which is
  // the one thing a quarantined row must not do. The scrape's own state is
  // stated as plain metadata on the row instead.
  const badge = withdrawn ? "withdrawn" : m !== undefined && !m.publishable ? "held" : "listed";
  return (
    <div className="listing" data-withdrawn={withdrawn}>
      <div className="listing-top">
        <span className="listing-title">
          {listing.permalink === null ? (
            listing.title
          ) : (
            <a href={listing.permalink} rel="nofollow noreferrer">
              {listing.title}
            </a>
          )}
        </span>
        <Trust state={badge} />
      </div>
      <div className="listing-meta">
        {listing.id} · {money(listing.price, listing.currency)} ·{" "}
        {listing.condition ?? "condition not stated"}
        {" · "}
        {listing.location ?? "location not stated"} · listed {dateOnly(listing.listedOn)}
        {" · "}last verified {stamp(listing.provenance.lastVerifiedAt)}
        {withdrawn ? " · permalink now 404, kept as history" : ""}
      </div>
      {m === undefined ? null : (
        <div className="basis">
          <span>
            {m.confidence.toFixed(2)} on {m.basis}
          </span>
          {m.matchedTokens.map((t) => (
            <span className="token" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}
      {m?.contradiction != null ? <p className="clash">clash: {m.contradiction}</p> : null}
    </div>
  );
}

export function Figure({
  value,
  label,
  emphasis,
}: {
  value: string | number;
  label: string;
  emphasis?: "refusal";
}) {
  return (
    <div className="figure" {...(emphasis !== undefined ? { "data-emphasis": emphasis } : {})}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

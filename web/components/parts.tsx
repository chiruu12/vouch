// Shared pieces. Two of them exist to make a rule structural rather than remembered.
//
// `Machine` is the only component that renders text the engine wrote, and it always
// renders it whole. There is no truncating variant, because a shortened refusal reads
// as a softer refusal.
//
// `ListingRow` takes a `PubListing` and cannot be given a seller, because the
// published type has no seller field. The snapshot strips it and the component could
// not display it if the strip failed.

import type { PubListing } from "../lib/data";
import { dateOnly, money, stamp } from "../lib/data";

export function Trust({ state }: { state: string }) {
  return (
    <span className="badge" data-trust={state}>
      {state}
    </span>
  );
}

/** Text the engine produced, quoted verbatim and set in mono so the reader can see
 *  it was not rewritten on the way to the page. */
export function Machine({ children, tone }: { children: string; tone?: "refusal" }) {
  return (
    <p className="machine" {...(tone !== undefined ? { "data-tone": tone } : {})}>
      {children}
    </p>
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
  // The badge answers "what is this row's status", and inside a quarantine block the
  // answer is "held", not "the scrape that found it was verified". Showing the source
  // trust here read as an endorsement of the match, which is the one thing a
  // quarantined row must not do. Source trust lives in the block's provenance footer.
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
        {listing.id} · {money(listing.price, listing.currency)} · {listing.condition ?? "condition not stated"}
        {" · "}
        {listing.location ?? "location not stated"} · listed {dateOnly(listing.listedOn)}
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

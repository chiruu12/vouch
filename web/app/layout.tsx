import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { snapshot, stamp } from "../lib/data";

const serif = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

const sans = IBM_Plex_Sans({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vouch",
  description:
    "A product recall feed that states what it verified, what it repaired, and what it refused to publish.",
};

/** The health rail is on every page rather than tucked into an about section. A feed
 *  that only shows its sources' state when asked is asking to be trusted; one that
 *  shows it beside every record is showing its work. */
function Rail() {
  const snap = snapshot();
  const t = snap.totals;
  return (
    <aside className="rail">
      <div>
        <h1 className="wordmark">
          <a href="/">Vouch</a>
        </h1>
        <p className="tagline">
          Recalled products, and where they are still for sale. Nothing published that the
          system cannot vouch for.
        </p>
      </div>

      <nav className="nav" aria-label="Sections">
        <a href="/">
          Feed <span className="count">{t.recalls}</span>
        </a>
        <a href="/incidents">
          Incident log <span className="count">{t.refusals} refusals</span>
        </a>
        <a href="/method">
          Method and limits <span className="count">measured</span>
        </a>
      </nav>

      <div>
        <p className="eyebrow">Sources</p>
        <div className="sources">
          {snap.sources.map((s) => (
            <div className="source" key={s.id}>
              <div className="source-name">{s.label}</div>
              <div className="prov" style={{ paddingTop: 0, borderTop: 0 }}>
                <span className="badge" data-trust={s.trust}>
                  {s.trust}
                </span>
              </div>
              <div className="source-meta">
                {s.rows} rows · contract {s.contractVersion} {s.contractPassed ? "pass" : "FAIL"}
                <br />
                {s.scraped ? `collector ${s.collectorId ?? "none"}` : "publisher API, not scraped"}
                <br />
                last verified {stamp(s.lastVerifiedAt)}
                {s.withdrawnRefs.length > 0 ? (
                  <>
                    <br />
                    {s.withdrawnRefs.length} withdrawn at source
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="eyebrow">This snapshot</p>
        <dl className="tally">
          <dt>Recalls held</dt>
          <dd>{t.recalls}</dd>
          <dt>Listings watched</dt>
          <dd>{t.listingsWatched}</dd>
          <dt>Matches asserted</dt>
          <dd>{t.asserted}</dd>
          <dt>Held in quarantine</dt>
          <dd>{t.quarantined}</dd>
          <dt>Withdrawn at source</dt>
          <dd>{t.withdrawn}</dd>
          <dt>Repairs refused</dt>
          <dd data-emphasis="refusal">{t.refusals}</dd>
        </dl>
        <div className="source-meta" style={{ marginTop: "0.6rem" }}>
          published {stamp(snap.generatedAt)}
        </div>
      </div>
    </aside>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <Rail />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import "./globals.css";
import { SyntheticTag, Trust } from "../components/parts";
import { ThemeControl } from "../components/theme";
import { snapshot, stamp } from "../lib/data";

// A public-records serif for headings and figures: the feed reads as a gazette
// of notices, and Newsreader is a newspaper face rather than an editorial one.
// IBM Plex Sans carries the interface text and IBM Plex Mono carries everything
// the system wrote, so the typeface alone says whose words you are reading.
const serif = Newsreader({
  weight: ["400", "500", "600"],
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

// Stamps a stored theme choice before first paint so a reader who picked light
// or dark never sees the wrong theme flash. "system" is the absence of the
// attribute, which is a real third state, not a default that forgot to stamp.
const themeBoot =
  "try{var t=localStorage.getItem('vouch-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}";

/** The health strip is on every page rather than tucked into an about section.
 *  A feed that only shows its sources' state when asked is asking to be
 *  trusted; one that shows it beside every record is showing its work. */
function HealthStrip() {
  const snap = snapshot();
  return (
    <div className="health">
      <div className="shell">
        <div className="health-inner">
          {snap.sources.map((s) => (
            <div className="source" key={s.id}>
              <div className="source-top">
                <span className="source-name">{s.label}</span>
                <Trust state={s.trust} />
              </div>
              <div className="source-meta">
                {s.synthetic ? (
                  <>
                    <SyntheticTag />{" "}
                  </>
                ) : null}
                {s.rows} rows · contract {s.contractVersion}{" "}
                {s.contractPassed ? "pass" : <span className="fail">FAIL</span>}
                <br />
                {s.scraped ? `collector ${s.collectorId ?? "none"}` : "publisher API, not scraped"}
                {" · "}last verified {stamp(s.lastVerifiedAt)}
                {s.withdrawnRefs.length > 0 ? (
                  <>
                    <br />
                    {s.withdrawnRefs.length} withdrawn at source, kept as history
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Masthead() {
  const t = snapshot().totals;
  return (
    <header className="masthead-wrap">
      <div className="shell">
        <div className="masthead">
          <div className="masthead-id">
            <p className="wordmark">
              <a href="/">Vouch</a>
            </p>
            <p className="tagline">
              Recalled products, and where they are still for sale. Nothing published that the
              system cannot vouch for.
            </p>
          </div>
          <div className="masthead-side">
            <nav className="nav" aria-label="Sections">
              <a href="/">
                Feed<span className="count">{t.recalls}</span>
              </a>
              <a href="/incidents">
                Incidents<span className="count">{t.refusals} refusals</span>
              </a>
              <a href="/method">
                Method<span className="count">measured</span>
              </a>
            </nav>
            <ThemeControl />
          </div>
        </div>
      </div>
    </header>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
        <a className="skip" href="#main">
          Skip to the feed
        </a>
        <Masthead />
        <HealthStrip />
        <div className="shell">
          {/* tabIndex is what makes the skip link move focus in WebKit; without it
              Safari scrolls to the feed and the next Tab starts from the top again. */}
          <main className="main" id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

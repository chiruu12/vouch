// What an agent gets, and what it is refused.
//
// Every block of machine text on this page comes out of `snapshot.agents`, which the
// engine produced by asking the real `recallContext` two questions in two worlds and
// rendering the answers with the same function an MCP client receives. Nothing here is
// typed out. A page that hand-wrote the refusal it claims the service produces would be
// the exact failure this project exists to complain about, and `verify-output.mjs` holds
// each of these strings to the byte.

import { Machine } from "../../components/parts";
import { snapshot } from "../../lib/data";

export const metadata = {
  title: "For agents",
  description: "The same feed answered for something that will act on the answer, and refused the same way.",
};

export default function Page() {
  const snap = snapshot();
  const view = snap.agents;

  if (view === undefined) {
    // The snapshot predates this page. Say so rather than render an empty argument.
    return (
      <header className="page-head">
        <p className="eyebrow">For agents</p>
        <h1 className="page">Not in this snapshot</h1>
        <p className="lede">
          This snapshot was published before the context service existed, so there is nothing
          measured to show. Run the supervision cycle again to fill it.
        </p>
      </header>
    );
  }

  const verified = view.beats.filter((b) => b.world === "verified");
  const failing = view.beats.filter((b) => b.world === "failing");

  return (
    <>
      <header className="page-head">
        <p className="eyebrow">For agents</p>
        <h1 className="page">Ask Vouch, do not scrape it</h1>
        <p className="lede">
          The site and the context service publish from one snapshot. The difference is who is
          asking. A person reads &ldquo;unverified, last checked four hours ago&rdquo; in the
          margin and discounts the row. A model flattens the row into a sentence, and the margin
          is the first thing to go. So the guarantee is not a field beside the data. It is the
          shape of the reply.
        </p>
      </header>

      <section className="block" aria-labelledby="rule-h">
        <div className="section-head">
          <h2 className="section" id="rule-h">
            Presence survives staleness. Absence does not.
          </h2>
        </div>
        <div className="prose">
          <p>
            The obvious rule would be that a broken source answers nothing. It is wrong, and
            wrong in a direction that causes its own harm. A recall notice does not expire, so a
            recall we saw four hours ago is still a recall, and withholding it from the person
            about to buy the product would be the worse mistake.
          </p>
          <p>
            <strong>I found nothing</strong> is a different claim, and it is the one that gets
            somebody hurt. A source is unverified here because it failed its contract, and the
            usual way to fail one is to come back with fewer rows than the baseline. Silence
            from a source that just lost a third of its records is not evidence of absence.
          </p>
        </div>
      </section>

      <section className="block" aria-labelledby="beats-h">
        <div className="section-head">
          <h2 className="section" id="beats-h">
            Same data, same query, opposite answers
          </h2>
        </div>

        <div className="agent-cols">
          <div className="agent-col">
            <h3 className="agent-world">Every source verified</h3>
            {verified.map((b) => (
              <div className="agent-beat" key={`v-${b.query}`}>
                <Machine label={`ask "${b.query}"`}>{b.digest}</Machine>
              </div>
            ))}
          </div>

          <div className="agent-col">
            <h3 className="agent-world">
              The recall source fails its contract <span className="agent-sim">simulated</span>
            </h3>
            <p className="agent-breach">{view.simulatedBreach}</p>
            {failing.map((b) => (
              <div className="agent-beat" key={`f-${b.query}`}>
                <Machine label={`ask "${b.query}"`} {...(b.refused ? { tone: "refusal" as const } : {})}>
                  {b.digest}
                </Machine>
              </div>
            ))}
          </div>
        </div>

        <div className="prose">
          <p>
            The second column is this snapshot edited in memory to show the rule, labelled
            everywhere it appears. It is not a live incident. The breach quoted is the shape of
            a real row-count cliff, which the incident log records happening.
          </p>
        </div>
      </section>

      <section className="block" aria-labelledby="tools-h">
        <div className="section-head">
          <h2 className="section" id="tools-h">
            Four tools, no credentials
          </h2>
        </div>
        <div className="prose">
          <p>
            <code>npm run mcp</code> serves these over MCP on stdio. The server reads a published
            snapshot and never scrapes, which is the same separation the site relies on: trust
            state is a property of a completed cycle, so the cycle publishes and everything else
            renders. Each description says what the result does not license, because that is the
            only thing a model reads before deciding what to do with it.
          </p>
        </div>
        <dl className="agent-tools">
          {view.tools.map((t) => (
            <div className="agent-tool" key={t.name}>
              <dt>{t.name}</dt>
              <dd>{t.description}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

// The agent view, computed by the engine so the page can only render it.
//
// The site never scrapes and never decides; it renders what a completed cycle
// published, and the output gate holds it to those strings verbatim. That rule is the
// reason this file exists rather than four code blocks typed into JSX. A page that
// hand-wrote the refusal it claims the service produces would be exactly the thing this
// project complains about, and nothing would notice when the two drifted apart.
//
// So the four beats are produced by calling the real `recallContext` against the real
// snapshot, and rendered with the same `digestAnswer` an MCP client receives. If the
// refusal wording changes, the page changes, and if the page is edited to say something
// the engine did not, the build fails.

import { recallContext } from "./context.js";
import { volumeBreach } from "./contract.js";
import { digestAnswer } from "./wire.js";
import { TOOLS } from "./mcp.js";
import type { Snapshot } from "./snapshot.js";

export interface PubAgentBeat {
  query: string;
  /** Which column this belongs in. */
  world: "verified" | "failing";
  /** Byte for byte what an agent receives. */
  digest: string;
  /** True when the service declined to answer. Carried rather than inferred from the
   *  text, so a template cannot decide for itself what counts as a refusal. */
  refused: boolean;
}

export interface PubAgentView {
  /** The breach used for the failing column. Stated in full and labelled everywhere it
   *  appears: this is a snapshot edited in memory to show the rule, not a live incident,
   *  and a demo that could be mistaken for one is not worth having. */
  simulatedBreach: string;
  /** The two questions, asked in both worlds. */
  beats: PubAgentBeat[];
  tools: { name: string; description: string }[];
}

/** The same feed after a cycle that failed its contract on a row-count cliff.
 *
 *  Built in memory and never written. The breach sentence comes from `volumeBreach`, the
 *  same function the contract checker calls, and the row counts come from the source in
 *  the snapshot being passed in. Both details are load-bearing. This used to hand-write
 *  the sentence and hardcode a baseline of 29 against a source that has six rows, which
 *  produced a grammar the engine cannot emit describing a cliff that never happened. */
/** A cliff this source could actually fall off, stated in the engine's own words.
 *
 *  Derived from the rows the snapshot really carries rather than a number chosen to look
 *  dramatic, so the illustration stays true when the sample behind it changes. Losing a
 *  third of the rows is comfortably past the 20% limit every contract here sets. */
export function cliffFor(snap: Snapshot): { breach: string; before: number; after: number } {
  const before = snap.sources.find((s) => s.id === "cpsc")?.rows ?? 6;
  const after = Math.floor(before * (2 / 3));
  return { breach: volumeBreach(before, after, 0.2), before, after };
}

export function simulateFailingSource(snap: Snapshot): Snapshot {
  const { breach, after } = cliffFor(snap);
  return {
    ...snap,
    sources: snap.sources.map((s) =>
      s.id === "cpsc"
        ? { ...s, trust: "unverified" as const, contractPassed: false, rows: after, breaches: [breach] }
        : s
    ),
    recalls: snap.recalls.map((r) =>
      r.provenance.sourceId === "cpsc"
        ? { ...r, provenance: { ...r.provenance, trust: "unverified" as const } }
        : r
    ),
  };
}

export function buildAgentView(snap: Snapshot, now: Date): PubAgentView {
  const simulatedBreach = cliffFor(snap).breach;
  const failing = simulateFailingSource(snap);

  // One query that hits and one that does not, asked in both worlds. Four beats is the
  // whole argument: the hit survives the breakage and the miss does not.
  const hit = snap.recalls[0]?.title.split(" ").slice(0, 4).join(" ") ?? "pressure washer";
  const miss = "wireless bluetooth headphones";

  const beats: PubAgentBeat[] = [];
  for (const [world, world_snap] of [
    ["verified", snap],
    ["failing", failing],
  ] as const) {
    for (const query of [hit, miss]) {
      const a = recallContext(world_snap, query, now);
      beats.push({ query, world, digest: digestAnswer(a), refused: a.refusalCode !== null });
    }
  }

  return {
    simulatedBreach,
    beats,
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  };
}

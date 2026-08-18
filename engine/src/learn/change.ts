// What the evolver is allowed to propose, as a type the compiler can check.
//
// The first version of this was one interface with an optional field for every kind of
// change: `canonical?`, `raw?`, `marker?`. That shape cannot express "a gone-marker
// change carries a marker", so nothing stopped a half-built change reaching the apply
// step, and `applyAlias` had to re-check at runtime what the type should have
// guaranteed. A discriminated union moves that check to the compiler: a change that
// does not carry what its kind requires is not constructible.
//
// Every kind carries its own evidence in numbers rather than prose, because the whole
// argument for letting a machine change this system unattended is that a person can
// audit the reason afterwards in a diff.

/** A field name a source used that the adapters did not know about. */
export interface AliasChange {
  kind: "alias";
  source: string;
  canonical: string;
  raw: string;
  what: string;
  evidence: string;
  /** The collector the capture came from, recorded in the alias log so a learned name
   *  can be traced back to the collector that started using it. */
  collectorId?: string | null;
}

/** A phrase that appears on pages proved gone and never on pages proved live. */
export interface GoneMarkerChange {
  kind: "gone-marker";
  source: string;
  marker: string;
  /** Distinct records whose page was proved gone and carried this phrase. */
  goneRefs: number;
  /** Records proved live whose page carried it. A candidate is only offered at zero. */
  liveRefs: number;
  what: string;
  evidence: string;
}

/** An observation about which repair instructions actually survive measurement. */
export interface HealStrategyChange {
  kind: "heal-strategy";
  cause: string;
  /** The shape being recommended, and the one being recommended against. */
  prefer: string;
  over: string;
  what: string;
  evidence: string;
}

export type Change = AliasChange | GoneMarkerChange | HealStrategyChange;

export type Kind = Change["kind"];

/** A stable key for de-duplicating changes several pieces of evidence agree on. */
export function changeKey(c: Change): string {
  switch (c.kind) {
    case "alias":
      return `alias|${c.source}|${c.canonical}|${c.raw}`;
    case "gone-marker":
      return `gone-marker|${c.source}|${c.marker}`;
    case "heal-strategy":
      return `heal-strategy|${c.cause}|${c.prefer}|${c.over}`;
  }
}

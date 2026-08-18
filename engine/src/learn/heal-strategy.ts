// Does the attacker-written half of a repair instruction earn its place?
//
// `prompt.ts` builds a repair instruction from clauses. One is ours: the selector we
// watched stop matching. Two are copied out of the page we just scraped: the attribute
// hooks and the visible field labels observed in the live document. That second group
// is written by whoever controls the page, and it is the largest free-text channel from
// a scraped site into an instruction we hand to a model that can rewrite our collector.
//
// The usual answer to that is a sanitiser, and there is one. The better question is
// whether the clause is worth having at all, because a clause that does not measurably
// improve repairs is pure attack surface. That is not a matter of opinion: every repair
// this system has ever attempted was measured by re-running the collector against the
// contract, so each one is a labelled outcome, and the prompts are recorded verbatim.
//
// So this learner reads the log and asks, per cause, whether repairs carrying observed
// markup verified more often than repairs without it. It never edits a prompt. A bad
// repair instruction has permanently wedged a collector in this account and a wedged
// collector cannot be recovered from the CLI, so the output is an argument for a person,
// with the counts attached and the sample size stated plainly.

export interface HealRecord {
  cause: string;
  /** The instruction as sent. Null when the cause was refused and no prompt exists. */
  prompt: string | null;
  /** Did the re-run satisfy the contract? This is the only definition of a good repair
   *  used anywhere in this project: the vendor reporting success is not evidence. */
  verified: boolean;
}

/** The clauses prompt.ts adds from observed markup, matched on their fixed wording. */
const OBSERVED_MARKUP = [/Attribute hooks present in the live document:/i, /Visible field labels are now:/i];

export const carriesObservedMarkup = (prompt: string): boolean =>
  OBSERVED_MARKUP.some((re) => re.test(prompt));

export interface Split {
  cause: string;
  withMarkup: { ok: number; total: number };
  withoutMarkup: { ok: number; total: number };
}

export function splitByMarkup(records: readonly HealRecord[]): Split[] {
  const byCause = new Map<string, Split>();
  for (const r of records) {
    if (r.prompt === null) continue;
    const s =
      byCause.get(r.cause) ??
      ({ cause: r.cause, withMarkup: { ok: 0, total: 0 }, withoutMarkup: { ok: 0, total: 0 } } as Split);
    const bucket = carriesObservedMarkup(r.prompt) ? s.withMarkup : s.withoutMarkup;
    bucket.total++;
    if (r.verified) bucket.ok++;
    byCause.set(r.cause, s);
  }
  return [...byCause.values()].sort((a, b) => a.cause.localeCompare(b.cause));
}

export interface StrategyFinding {
  cause: string;
  prefer: string;
  over: string;
  evidence: string;
}

/** The smallest number of measured repairs on each side before a comparison is worth
 *  reporting. Two is not significance and this does not pretend otherwise; the finding
 *  says how many it saw so the reader can discount it. */
export const MIN_PER_SIDE = 2;

export function proposeStrategies(records: readonly HealRecord[]): StrategyFinding[] {
  const out: StrategyFinding[] = [];
  for (const s of splitByMarkup(records)) {
    const { withMarkup: w, withoutMarkup: o } = s;

    if (w.total < MIN_PER_SIDE || o.total < MIN_PER_SIDE) {
      // Not enough to compare. Say so rather than reporting a rate built on one run:
      // the point of measuring repairs is to stop trusting a single flattering result.
      out.push({
        cause: s.cause,
        prefer: "no change",
        over: "no change",
        evidence:
          `not enough measured repairs for ${s.cause} to compare prompt shapes: ` +
          `${w.total} with observed markup, ${o.total} without, and a side needs ${MIN_PER_SIDE}`,
      });
      continue;
    }

    const withRate = w.ok / w.total;
    const withoutRate = o.ok / o.total;
    const pct = (n: number): string => `${Math.round(n * 100)}%`;

    if (withoutRate >= withRate) {
      out.push({
        cause: s.cause,
        prefer: "prompt without observed markup",
        over: "prompt carrying observed hooks and labels",
        evidence:
          `${s.cause}: repairs without observed markup verified ${o.ok}/${o.total} (${pct(withoutRate)}), ` +
          `with it ${w.ok}/${w.total} (${pct(withRate)}). The clause is copied from the scraped page, ` +
          `so it is the largest attacker-written part of the instruction, and it is not paying for itself`,
      });
    } else {
      out.push({
        cause: s.cause,
        prefer: "prompt carrying observed hooks and labels",
        over: "prompt without observed markup",
        evidence:
          `${s.cause}: repairs carrying observed markup verified ${w.ok}/${w.total} (${pct(withRate)}), ` +
          `without it ${o.ok}/${o.total} (${pct(withoutRate)}). The clause earns its place, so the ` +
          `sanitiser in prompt.ts is what keeps it safe rather than removing it`,
      });
    }
  }
  return out;
}

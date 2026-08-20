// How an answer is spelled on the way to a model, as opposed to what it says.
//
// `context.ts` decides what we are entitled to claim. This file decides what that costs
// to read, and the two are kept apart because they answer to different things: the first
// to the evidence, the second to a token budget. A change here must never be able to
// alter a verdict, which is why nothing in this file takes a snapshot or a query.
//
// Three things drive the cost, and they are all structural rather than a matter of
// trimming words:
//
//   Pretty-printed JSON is about a fifth of the payload in indentation alone. A model
//   does not need the indentation, and every space is billed.
//
//   Provenance repeats. Five recalls from one source carried five copies of the same
//   source label, state and timestamp. Hoisted into one block they are stated once.
//
//   The caveat is constant. Sending the same sentence about product lines versus units
//   on every single call bills a fixed cost per query for a fact that never changes. It
//   belongs in the server's instructions, which are sent once per session.
//
// The digest is the default because a tool result is read by a model, not parsed by a
// program: braces, quotes and repeated keys are all cost with no reader. JSON is still
// available for anything that really is parsing, and both are produced from this one
// file so they cannot drift apart.

import type { ContextAnswer, BreakageReport, QuarantinedRecall, Vouched } from "./context.js";

/** Minute precision. Seconds and milliseconds on a "last confirmed" timestamp are three
 *  tokens spent on a distinction nobody acts on. */
export function shortTime(iso: string | null): string | null {
  return iso === null ? null : iso.slice(0, 16).replace("T", " ");
}

/** Drop keys whose value carries nothing: null, empty string, empty array.
 *
 *  An omitted key and a null key mean the same thing to a reader and one of them is
 *  free. `risk: "Unknown"` goes too, because a field whose value is the word for "we do
 *  not know" is a null wearing a costume. */
export function dense<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === "" || v === "Unknown") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

const sourceKey = (v: Vouched): string => v.sourceId;

/** The compact JSON form. Same information as `ContextAnswer` minus the constant caveat,
 *  with provenance stated once per source instead of once per record. */
export function compactAnswer(a: ContextAnswer): Record<string, unknown> {
  const srcs: Record<string, unknown> = {};
  for (const r of a.asserted) {
    const k = sourceKey(r.vouch);
    if (srcs[k] !== undefined) continue;
    srcs[k] = dense({
      label: r.vouch.sourceLabel,
      state: r.vouch.state,
      confirmed: shortTime(r.vouch.lastVerifiedAt),
      stale: r.vouch.stale ? true : null,
      synthetic: r.vouch.synthetic ? true : null,
    });
  }

  return dense({
    refused: a.refusalCode,
    why: a.refusal,
    caution: a.caution,
    at: shortTime(a.askedAt),
    recalls: a.asserted.map((r) =>
      dense({
        ref: r.ref,
        title: r.title,
        brand: r.brand,
        risk: r.risk,
        hazard: r.hazard,
        do: r.action,
        link: r.permalink,
        published: r.published,
        conf: r.confidence,
        basis: r.basis,
        on: r.matchedTokens,
        src: sourceKey(r.vouch),
      })
    ),
    src: Object.keys(srcs).length > 0 ? srcs : null,
    withheld: a.withheld.map((w) => `${w.count}x ${w.reason}`),
  });
}

/** The digest. A strict line grammar, because a model reads this and a loose one invites
 *  it to improvise:
 *
 *    REFUSED <code>            first line when there is no answer, and nothing follows
 *                              it that could be mistaken for one
 *    CAUTION <text>            an answer follows, but something about it is qualified
 *    RECALL <ref> conf=<n> basis=<b> src=<id>
 *    <title>
 *      hazard: ... / do: ... / link: ... / matched: ...
 *    WITHHELD <n>x <reason>
 *    NONE                      we looked, we can vouch for the sources, nothing matched
 *    SRC <id> <label> | <state> | confirmed <time>
 */
export function digestAnswer(a: ContextAnswer): string {
  const out: string[] = [];

  if (a.refusalCode !== null) {
    // The code first and the sentence under it. A caller that reads one line reads the
    // one that stops it inventing an answer, and nothing below can be mistaken for a
    // result because there is nothing below.
    out.push(`REFUSED ${a.refusalCode}`);
    if (a.refusal !== null) out.push(a.refusal);
    return out.join("\n");
  }

  if (a.caution !== null) out.push(`CAUTION ${a.caution}`);

  if (a.asserted.length === 0) {
    out.push("NONE no recall matched, and every recall source is currently verified");
  }

  for (const r of a.asserted) {
    out.push(
      `RECALL ${r.ref} conf=${r.confidence.toFixed(2)} basis=${r.basis} src=${sourceKey(r.vouch)}`
    );
    out.push(r.title);
    if (r.risk !== "Unknown") out.push(`  risk: ${r.risk}`);
    if (r.hazard !== null) out.push(`  hazard: ${r.hazard}`);
    if (r.action !== null) out.push(`  do: ${r.action}`);
    if (r.permalink !== null) out.push(`  link: ${r.permalink}`);
    if (r.matchedTokens.length > 0) out.push(`  matched: ${r.matchedTokens.join(" ")}`);
  }

  for (const w of a.withheld) out.push(`WITHHELD ${w.count}x ${w.reason}`);

  out.push(...sourceLines(a.asserted.map((r) => r.vouch)));

  return out.join("\n");
}

/** One `SRC` line per distinct source, in first-seen order.
 *
 *  Shared by the asserted and quarantined digests rather than written twice. The
 *  quarantine tool used to build its own lines and carried no provenance at all, which
 *  is how a synthetic fixture recall reached agents unlabelled; two renderers is how the
 *  labelling stayed correct in one of them and absent in the other. */
function sourceLines(vouches: readonly Vouched[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of vouches) {
    const k = sourceKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    const bits = [v.sourceLabel, v.state, `confirmed ${shortTime(v.lastVerifiedAt) ?? "never"}`];
    if (v.synthetic) bits.push("SYNTHETIC FIXTURE");
    out.push(`SRC ${k} ${bits.join(" | ")}`);
  }
  return out;
}

/** The quarantine digest.
 *
 *    NEAR <ref> conf=<n> basis=<b> src=<id> held=<reason>
 *    <title>
 *    SRC <id> <label> | <state> | confirmed <time> [| SYNTHETIC FIXTURE]
 *
 *  `src` on the NEAR line and the SRC block under it are both new. A caller that asked
 *  for withheld records was previously told what was held and nothing about who held it,
 *  so it could not tell a fixture from a regulator. */
export function digestQuarantine(held: readonly QuarantinedRecall[]): string {
  if (held.length === 0) return "NONE nothing resembled this closely enough to quarantine";
  const out: string[] = [];
  for (const x of held) {
    out.push(
      `NEAR ${x.ref} conf=${x.confidence.toFixed(2)} basis=${x.basis} ` +
        `src=${sourceKey(x.vouch)} held=${x.reason}`
    );
    out.push(x.title);
  }
  out.push(...sourceLines(held.map((x) => x.vouch)));
  return out.join("\n");
}

/** Breakage as a digest. The retry line is the one a caller acts on, so it is its own
 *  line with the wait in seconds rather than buried in a sentence about milliseconds. */
export function digestBreakage(b: BreakageReport): string {
  const out: string[] = [
    `HEALTHY ${String(b.healthy)}  CAN_REPORT_ABSENCE ${String(b.canReportAbsence)}`,
  ];
  for (const s of b.sources) {
    if (s.cause === null && s.breaches.length === 0) {
      out.push(`OK ${s.id} ${s.state}`);
      continue;
    }
    out.push(`BROKEN ${s.id} ${s.state}${s.cause !== null ? ` cause=${s.cause}` : ""} healable=${String(s.healable)}`);
    for (const br of s.breaches) out.push(`  breach: ${br}`);
    out.push(
      s.advice.retry
        ? `  RETRY after=${Math.round(s.advice.afterMs / 1000)}s ${s.advice.why}`
        : `  NO_RETRY ${s.advice.why}`
    );
  }
  return out.join("\n");
}

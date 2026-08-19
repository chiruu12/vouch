# Vouch as a context service

```
npm run ask                          the four beats, in order
npm run ask -- "cooluli minifridge"  one question against the published snapshot
npm run mcp                          the same thing, over MCP on stdio
```

The feed and the context service publish from one snapshot. The difference is who is
asking, and it turns out that changes what we are allowed to say.

## The problem this is answering

Selling context to agents is mostly a delivery problem: more of it, fresher, in fewer
round trips. The part that gets left out is that a caller cannot tell fresh context from
stale context from context a scraper healed itself into producing. Handed a recall feed,
an agent will tell somebody "that product is recalled". Worse, it will tell somebody
"that product is fine".

Vouch already computes the thing that would prevent the second sentence. Every record it
publishes carries a trust state, a contract version, and the time of the last probe that
satisfied that contract. On the website that is enough, because a person reads
"unverified, last checked four hours ago" in the margin and discounts the row.

A model does not. It flattens the row into a sentence, and the margin is the first thing
to go. Provenance carried as a sibling field is advisory, and advisory is not a
guarantee.

So the guarantee moves into the shape of the reply.

## Presence survives staleness. Absence does not.

The obvious rule would be that an unverified source answers nothing. It is wrong, and
wrong in a direction that would cause its own harm.

**A stale hit is still a hit.** A recall notice does not expire. If we saw it four hours
ago and the source has broken since, the notice is still a notice. Withholding a real
recall from the person about to buy the product, in order to keep a rule tidy, would be
the worse mistake. It is served, with the time it was last confirmed, and a `caution`
saying so in words the caller can pass on.

**A stale miss is a refusal.** "I found nothing" is a different claim, and it is the one
that gets somebody hurt. A source is unverified here precisely because it failed its
contract, and the commonest way to fail one is to come back with fewer rows than the
baseline. Silence from a source that just lost a third of its records is not evidence of
absence. The service says it cannot answer, and says which source and why.

Same data, same query, opposite answers. The difference is not confidence. It is which
claim the evidence supports.

```
$ npm run ask

  2. THE RECALL SOURCE FAILS ITS CONTRACT   SIMULATED
  row count fell 31.0% against a baseline of 29, limit 20.0%
  canReportAbsence = false

  ask  "COMMOWNER Pressure Washers Recalled"
  ANSWER   26692  COMMOWNER Pressure Washers Recalled Due to Serious R
           brand+product at 0.72 on [pressure, washer, commowner]
           US CPSC, unverified, last confirmed 2026-08-17T13:13:32.000Z
  CAUTION  the notice itself does not expire, so it is reported with the
           time it was last confirmed rather than withheld.

  ask  "wireless bluetooth headphones"
  REFUSED  no recall matched, but this cannot be reported as "not
           recalled". US CPSC is not currently verified (row count fell
           31.0% against a baseline of 29, limit 20.0%).
```

## What is withheld is absent, not labelled

A near miss is a real recall that resembled the query without clearing the bar to assert
it. The website publishes those in full, next to the word "quarantined", where a reader
can weigh them. `recallContext` does not. It reports a count and a reason, and the record
itself is not in the payload.

The reasoning is the same one as above, applied to the other end. A near miss handed to
something that will summarise it becomes an assertion two hops later, and no amount of
labelling survives that trip. A caller cannot quote what it was not given.

They are still available. `quarantinedFor` returns them, and the name is the disclosure:
a caller has to decide to ask for near misses, by a tool whose description says they are
not recalls of this product. That is the same accept-versus-retract asymmetry the phrase
learner uses, in a different place.

## The refusal leads

Over MCP, a tool result is text a model reads top to bottom under a token budget. So the
refusal is the first line of the payload, not a field two hundred lines down:

```
REFUSED: no recall matched, but this cannot be reported as "not recalled" ...

{ "query": "...", "asserted": [], "withheld": [...] }
```

There is a mutation for that (`the refusal is appended below the payload instead of
leading it`), because the difference between leading and trailing is invisible in a
diff and total in effect.

## Tools

| Tool | Returns | The thing it will not let you conclude |
| --- | --- | --- |
| `recall_context` | recalls we will assert, with confidence and matched tokens, or a refusal | that a product is safe, when `refusal` is non-null |
| `vouch_report` | every source, its state, and `canReportAbsence` | that absence is reportable, when that flag is false |
| `quarantined_for` | near misses with the reason each was held back | that a near miss is a recall of this product |

Each description says what the result does not license, because the description is the
only thing a model reads before deciding what to do with the result. There is a test
asserting every tool has such a sentence.

## Notes on the implementation

**One matcher.** A query is scored by `scoreMatch`, the same function and the same
`PUBLISH_THRESHOLD` the website uses to decide what to assert. If an agent's answer were
scored by a friendlier path, the two could disagree about the same product while both
cited Vouch.

**The declared source list.** `RECALL_SOURCES` in `types.ts` is written by hand and
`unvouchedSources` walks it rather than walking the snapshot's own sources. A source
disappears from a build for exactly the reasons that should stop us reporting absence,
and a loop over what happens to be present cannot see the thing that is not there. A
declared source missing from the snapshot is a refusal.

**No SDK.** The server speaks the MCP wire protocol directly. The engine has no runtime
dependencies, and a service whose argument is that it refuses to serve what it cannot
verify is a poor place to start adding a supply chain.

**Snapshot reload.** The server caches the snapshot by mtime, so a supervision cycle that
publishes mid-session is picked up without a restart. Answering from a file read at boot
is the staleness this project exists to complain about.

## Wiring it into a client

```json
{
  "mcpServers": {
    "vouch": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/path/to/vouch/engine"
    }
  }
}
```

No credentials. The server reads a published snapshot and never scrapes, which is the
same separation the website relies on: trust state is a property of a completed cycle,
so the cycle publishes and everything else renders.

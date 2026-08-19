// Vouch as an MCP server: the feed, answered for an agent.
//
//   node --import tsx src/mcp.ts        # speaks MCP over stdio
//
// Context as a service is usually sold as more context, delivered faster. The part
// nobody sells is that a caller cannot tell fresh context from stale context from
// context a scraper healed itself into producing. Handed a recall feed, an agent will
// tell somebody "that product is recalled", or worse "that product is fine", and the
// margin note explaining which of those we were entitled to say is the first thing a
// summariser drops.
//
// So this server does not expose the feed. It exposes what we are entitled to claim
// about the feed, and the two are different objects. Every tool here returns either an
// assertion or a refusal, and the refusal is the first thing in the payload.
//
// Written against the wire protocol directly rather than the SDK. The engine has no
// runtime dependencies and a context service that refuses to serve what it cannot
// verify is a poor place to start adding a supply chain.

import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { recallContext, quarantinedFor, vouchReport, breakageReport } from "./context.js";
import { compactAnswer, digestAnswer, digestBreakage } from "./wire.js";
import type { Snapshot } from "./snapshot.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const SNAPSHOT = join(ROOT, "web", "public", "snapshot.json");

const PROTOCOL = "2024-11-05";
const SUPPORTED = new Set([PROTOCOL, "2025-03-26", "2025-06-18"]);

/** Reloaded when the file changes, so a supervision cycle that publishes mid-session is
 *  picked up without a restart. Cached by mtime rather than held forever: a context
 *  service that answers from a snapshot it read at boot is the staleness this project
 *  exists to complain about. */
let cache: { at: number; snap: Snapshot } | null = null;

function snapshot(): Snapshot {
  const mtime = statSync(SNAPSHOT).mtimeMs;
  if (cache === null || cache.at !== mtime) {
    cache = { at: mtime, snap: JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot };
  }
  return cache.snap;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the text a model will read. Each tool renders its own result, because the
   *  cheap spelling of an answer is not the same shape as the cheap spelling of a
   *  breakage report and a single generic serialiser would have to pick one. */
  run: (args: Record<string, unknown>) => string;
}

/** In every schema, so it is defined once and carries no prose. The enum states the
 *  values and being first states the default; four copies of a sentence explaining that
 *  is four copies of a sentence, on a payload sent to every client that connects. */
const FORMAT_ARG = { type: "string", enum: ["digest", "json"] } as const;

const productArg = {
  type: "object",
  properties: {
    product: {
      type: "string",
      description: "The product as described. A listing title works well.",
    },
    format: FORMAT_ARG,
  },
  required: ["product"],
} as const;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const wantsJson = (a: Record<string, unknown>): boolean => a.format === "json";
const j = (v: unknown): string => JSON.stringify(v);

export const TOOLS: Tool[] = [
  {
    name: "recall_context",
    description:
      "Is this product recalled? Returns recalls we will assert, with the confidence and " +
      "matched tokens behind each. A REFUSED line means you must not say the product is " +
      "safe or unrecalled; quote it and call breakage_report.",
    inputSchema: productArg as unknown as Record<string, unknown>,
    run: (a) => {
      const ans = recallContext(snapshot(), str(a.product));
      return wantsJson(a) ? j(compactAnswer(ans)) : digestAnswer(ans);
    },
  },
  {
    name: "vouch_report",
    description:
      "What each source can currently be vouched for. Read CAN_REPORT_ABSENCE before " +
      "telling anyone a product is NOT recalled; when false, absence is not a claim this " +
      "data supports.",
    inputSchema: { type: "object", properties: { format: FORMAT_ARG } },
    run: (a) => {
      const r = vouchReport(snapshot());
      return wantsJson(a)
        ? j(r)
        : [
            `CAN_REPORT_ABSENCE ${String(r.canReportAbsence)}`,
            ...r.sources.map(
              (s2) =>
                `${s2.kind === "recall" ? "RECALL_SRC" : "LISTING_SRC"} ${s2.id} ${s2.state} rows=${s2.rows}` +
                (s2.contractPassed ? "" : ` FAILING: ${s2.breaches.join("; ")}`) +
                (s2.synthetic ? " SYNTHETIC" : "")
            ),
          ].join("\n");
    },
  },
  {
    name: "breakage_report",
    description:
      "Why we are refusing, and whether calling again would help. Gives the open failure " +
      "per source and a retry wait measured from repairs that actually ran there. Call " +
      "this after a refusal instead of retrying: two of the four causes are never " +
      "repaired, so retrying them changes nothing.",
    inputSchema: { type: "object", properties: { format: FORMAT_ARG } },
    run: (a) => {
      const b = breakageReport(snapshot());
      return wantsJson(a) ? j(b) : digestBreakage(b);
    },
  },
  {
    name: "quarantined_for",
    description:
      "Near misses: recalls that resembled this product but did not clear the bar, with " +
      "why each was held back. These are NOT recalls of this product and must never be " +
      "reported as though they were.",
    inputSchema: productArg as unknown as Record<string, unknown>,
    run: (a) => {
      const q = quarantinedFor(snapshot(), str(a.product));
      if (wantsJson(a)) return j(q);
      return q.length === 0
        ? "NONE nothing resembled this closely enough to quarantine"
        : q.map((x) => `NEAR ${x.ref} conf=${x.confidence.toFixed(2)} basis=${x.basis} held=${x.reason}\n${x.title}`).join("\n");
    },
  },
];


interface Req {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export function handle(req: Req): object | null {
  const reply = (result: unknown): object => ({ jsonrpc: "2.0", id: req.id ?? null, result });

  switch (req.method) {
    case "initialize": {
      const asked = str((req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion);
      return reply({
        protocolVersion: SUPPORTED.has(asked) ? asked : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "vouch", version: "0.1.0" },
        // Everything constant lives here and is sent once. It used to ride on every
        // answer, which billed the same three sentences per query for facts that never
        // change. What a caller needs per answer is what is true of THAT answer.
        instructions: [
          "Vouch serves product recall context and refuses what it cannot verify.",
          "",
          "Reading a result: the first line is the verdict.",
          "  REFUSED <code>  no answer. Do NOT say the product is safe or unrecalled.",
          "                  Call breakage_report; do not simply retry.",
          "  NONE            we looked, every source is verified, nothing matched.",
          "  RECALL <ref>    a recall we assert, with conf= and the tokens it matched on.",
          "  CAUTION         an answer follows, but something about it is qualified.",
          "  WITHHELD <n>x   near misses, held back. They are NOT recalls of this product.",
          "  SRC <id>        provenance, stated once for all records from that source.",
          "",
          "A match is on the PRODUCT LINE, not on the individual unit. Recalls are often " +
            "limited to specific batches or serial ranges and listings rarely show them, so a " +
            "match means this appears to be the same product as a recall, not that this " +
            "particular item is affected. Say so when you relay one.",
          "",
          "A source marked stale may still report a recall it saw, because a notice does not " +
            "expire. It may not report that it found nothing.",
        ].join("\n"),
      });
    }
    // Notifications carry no id and get no reply. Answering one is a protocol error.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const p = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = TOOLS.find((t) => t.name === p.name);
      if (tool === undefined) {
        return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32602, message: `no tool named ${String(p.name)}` } };
      }
      try {
        const text = tool.run((p.arguments ?? {}) as Record<string, unknown>);
        return reply({ content: [{ type: "text", text }] });
      } catch (e: unknown) {
        // A failure to answer is reported as a failure, never as an empty result. An
        // empty result reads as "nothing found", which is the one thing this service is
        // built not to say by accident.
        return reply({
          content: [{ type: "text", text: `REFUSED: the query could not be answered (${e instanceof Error ? e.message : String(e)})` }],
          isError: true,
        });
      }
    }
    default:
      return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32601, message: `unknown method ${req.method}` } };
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && entry.endsWith("mcp.ts");
}

if (isMain()) {
  // stdout is the transport. Anything logged there corrupts a frame, so diagnostics go
  // to stderr and nothing else may print.
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    const text = line.trim();
    if (text === "") return;
    let req: Req;
    try {
      req = JSON.parse(text) as Req;
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"
      );
      return;
    }
    const res = handle(req);
    if (res !== null) process.stdout.write(JSON.stringify(res) + "\n");
  });
  process.stderr.write(`vouch mcp: serving ${SNAPSHOT}\n`);
}

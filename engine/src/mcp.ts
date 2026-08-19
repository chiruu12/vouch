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
import { recallContext, quarantinedFor, vouchReport } from "./context.js";
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
  run: (args: Record<string, unknown>) => unknown;
}

const productArg = {
  type: "object",
  properties: {
    product: {
      type: "string",
      description: "The product as the person described it. A listing title works well.",
    },
  },
  required: ["product"],
} as const;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const TOOLS: Tool[] = [
  {
    name: "recall_context",
    description:
      "Ask whether a product is subject to a safety recall. Returns recalls this service " +
      "is willing to assert, each with the confidence and the matched tokens behind it, or " +
      "a refusal. IMPORTANT: when `refusal` is non-null you must not tell the user the " +
      "product is safe or unrecalled. Quote the refusal instead. A match is on the product " +
      "line, never on the individual unit.",
    inputSchema: productArg as unknown as Record<string, unknown>,
    run: (a) => recallContext(snapshot(), str(a.product)),
  },
  {
    name: "vouch_report",
    description:
      "What this service can and cannot currently vouch for, source by source. Read " +
      "`canReportAbsence` before telling anyone a product is NOT recalled: when it is " +
      "false, absence is not a claim this data supports.",
    inputSchema: { type: "object", properties: {} },
    run: () => vouchReport(snapshot()),
  },
  {
    name: "quarantined_for",
    description:
      "Near misses for a product: recalls that resembled it but did not clear the bar to " +
      "assert, with the reason each was held back. These are NOT recalls of this product " +
      "and must never be reported as though they were. Kept out of recall_context on " +
      "purpose, so asking for them is a deliberate act.",
    inputSchema: productArg as unknown as Record<string, unknown>,
    run: (a) => quarantinedFor(snapshot(), str(a.product)),
  },
];

/** The refusal leads. A caller that reads only the first line of a tool result should
 *  read the part that stops it inventing an answer, not the part it can quote. */
export function renderResult(payload: unknown): string {
  const p = payload as { refusal?: string | null; caution?: string | null };
  const head: string[] = [];
  if (p !== null && typeof p === "object") {
    if (typeof p.refusal === "string" && p.refusal.length > 0) head.push(`REFUSED: ${p.refusal}`);
    if (typeof p.caution === "string" && p.caution.length > 0) head.push(`CAUTION: ${p.caution}`);
  }
  return [...head, JSON.stringify(payload, null, 2)].join("\n\n");
}

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
        instructions:
          "Vouch serves product recall context and refuses what it cannot verify. Never " +
          "report a product as safe or unrecalled on the strength of an empty result: check " +
          "`refusal` and `vouch_report.canReportAbsence` first. Matches are on the product " +
          "line, not the individual unit.",
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
        const out = tool.run((p.arguments ?? {}) as Record<string, unknown>);
        return reply({ content: [{ type: "text", text: renderResult(out) }] });
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

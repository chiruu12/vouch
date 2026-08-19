// The wire layer. Small, but two of these are the kind of thing that silently half
// works: a notification that gets answered breaks a client mid-handshake, and a
// refusal buried under two hundred lines of JSON is a refusal nothing will read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handle, renderResult } from "./mcp.js";

const call = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
  handle({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) as
    | { result?: Record<string, unknown>; error?: { code: number; message: string } }
    | null;

test("initialize echoes a protocol version the client asked for when we support it", () => {
  const r = call("initialize", { protocolVersion: "2025-06-18" })!;
  assert.equal((r.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
});

test("initialize falls back rather than echoing a version we do not speak", () => {
  const r = call("initialize", { protocolVersion: "1999-01-01" })!;
  assert.equal((r.result as { protocolVersion: string }).protocolVersion, "2024-11-05");
});

test("initialize tells the client what it must not do with an empty result", () => {
  const i = (call("initialize", {})!.result as { instructions: string }).instructions;
  assert.match(i, /never/i);
  assert.match(i, /unrecalled|not recalled|safe/i);
});

test("a notification is not answered", () => {
  // JSON-RPC forbids a response to a notification, and a client that receives one
  // during the handshake will usually drop the connection.
  assert.equal(handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(handle({ jsonrpc: "2.0", method: "notifications/cancelled" }), null);
});

test("every tool is listed with a schema a client can build a form from", () => {
  const tools = (call("tools/list")!.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
  assert.equal(tools.length, TOOLS.length);
  for (const t of tools) assert.equal(t.inputSchema.type, "object");
});

test("every tool description says what the caller may not conclude", () => {
  // The descriptions are the only thing a model reads before deciding what to do with
  // the result, so the refusal semantics have to be in them and not only in the docs.
  for (const t of TOOLS) {
    assert.match(
      t.description,
      /must not|never|before telling/i,
      `${t.name} describes what it returns without saying what it does not license`
    );
  }
});

test("an unknown tool is an error, not an empty result", () => {
  // An empty result reads as "nothing found", which for this service is a safety claim.
  const r = call("tools/call", { name: "nope", arguments: {} })!;
  assert.equal(r.result, undefined);
  assert.equal(r.error?.code, -32602);
});

test("an unknown method is a JSON-RPC error", () => {
  assert.equal(call("tools/nonsense")!.error?.code, -32601);
});

test("the refusal is the first thing in a rendered result", () => {
  const text = renderResult({ refusal: "cannot report absence", asserted: [], withheld: [] });
  assert.ok(text.startsWith("REFUSED: cannot report absence"), text.slice(0, 60));
});

test("a caution rides above the payload too, without being a refusal", () => {
  const text = renderResult({ refusal: null, caution: "one source is stale", asserted: [{ ref: "R-1" }] });
  assert.ok(text.startsWith("CAUTION: one source is stale"));
  assert.ok(text.includes("R-1"), "an answer with a caution still carries the answer");
});

test("a plain answer renders without either banner", () => {
  const text = renderResult({ refusal: null, caution: null, asserted: [] });
  assert.ok(!text.includes("REFUSED"));
  assert.ok(!text.includes("CAUTION"));
});

test("a live tools/call answers from the published snapshot", () => {
  // Integration, on purpose: the unit tests all take a snapshot they built themselves,
  // so nothing else would notice the server reading the wrong file or the wrong shape.
  const r = call("tools/call", { name: "vouch_report", arguments: {} })!;
  const text = (r.result as { content: { text: string }[] }).content[0]!.text;
  const report = JSON.parse(text) as { canReportAbsence: boolean; sources: { id: string }[] };
  assert.equal(typeof report.canReportAbsence, "boolean");
  assert.ok(report.sources.length > 0);
});

// The wire layer. Small, but two of these are the kind of thing that silently half
// works: a notification that gets answered breaks a client mid-handshake, and a
// refusal buried under two hundred lines of JSON is a refusal nothing will read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handle, resetSession } from "./mcp.js";

const call = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
  handle({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) as
    | { result?: Record<string, unknown>; error?: { code: number; message: string } }
    | null;

// A tool call is refused until the session has been initialized, and the flag lives in
// the module rather than in each call. Every test below that reaches a tool wants a
// handshaken session, so it is done once, here, in the open. The two tests that care
// about the handshake itself drive it deliberately and put it back when they are done:
// a test that leaves module state changed is a test that breaks whatever runs next.
call("initialize", {});

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
  assert.match(i, /never|do not/i);
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

test("the session instructions carry the constant facts, so answers do not", () => {
  // The caveat about product lines versus units used to ride on every answer. It never
  // changes, so it is billed once per session here instead of once per query.
  const i = (call("initialize", {})!.result as { instructions: string }).instructions;
  assert.match(i, /PRODUCT LINE/);
  assert.match(i, /REFUSED/);
  assert.match(i, /breakage_report/);
});

const textOf = (r: { result?: unknown }): string =>
  (r.result as { content: { text: string }[] }).content[0]!.text;

test("a live tools/call answers from the published snapshot, in both formats", () => {
  // Integration, on purpose: the unit tests all take a snapshot they built themselves,
  // so nothing else would notice the server reading the wrong file or the wrong shape.
  const asJson = textOf(call("tools/call", { name: "vouch_report", arguments: { format: "json" } })!);
  const report = JSON.parse(asJson) as { canReportAbsence: boolean; sources: { id: string }[] };
  assert.equal(typeof report.canReportAbsence, "boolean");
  assert.ok(report.sources.length > 0);

  // The digest is the default, and it has to say the same thing in fewer tokens rather
  // than a different thing.
  const asDigest = textOf(call("tools/call", { name: "vouch_report", arguments: {} })!);
  assert.match(asDigest, /^CAN_REPORT_ABSENCE (true|false)/);
  assert.equal(asDigest.includes("CAN_REPORT_ABSENCE true"), report.canReportAbsence);
  assert.ok(asDigest.length < asJson.length, "the digest must be the cheaper of the two");
});

test("every tool answers in both formats", () => {
  for (const t of TOOLS) {
    const args = t.inputSchema as { required?: string[] };
    const base = args.required?.includes("product") === true ? { product: "kettle" } : {};
    for (const format of ["digest", "json"]) {
      const r = call("tools/call", { name: t.name, arguments: { ...base, format } })!;
      assert.equal(r.error, undefined, `${t.name} failed in ${format}`);
      assert.ok(textOf(r).length > 0, `${t.name} returned nothing in ${format}`);
    }
  }
});

test("breakage_report tells a caller whether retrying is pointless", () => {
  // The reason this tool exists. An agent told only "I cannot answer" retries, because
  // retrying is the only move it has, and two of the four causes never recover from it.
  const text = textOf(call("tools/call", { name: "breakage_report", arguments: {} })!);
  assert.match(text, /^HEALTHY (true|false)\s+CAN_REPORT_ABSENCE (true|false)/);
  for (const line of text.split("\n")) {
    if (line.startsWith("BROKEN")) {
      assert.match(line, /healable=(true|false)/, "a broken source must say whether a repair is even allowed");
    }
  }
});

// The caveat is sent once, so the session that never received it may not be answered.
//
// `initialize` carries the sentence that a match is on the product line and not on the
// individual unit, and it is sent once per session rather than stapled to every answer,
// because a constant costs tokens on every call for a fact that never changes. That
// trade only holds while the client has actually been told. A `tools/call` arriving with
// no handshake behind it would otherwise be answered with `RECALL <ref> conf=0.72` and
// the notice's own "stop using it immediately" line, and nothing anywhere in that reply
// saying it matched a product line rather than the unit in front of the caller. That is
// the one claim this project refuses to make, reachable by skipping a step.
test("a tool call before the handshake is refused rather than answered", () => {
  resetSession();
  const r = call("tools/call", { name: "recall_context", arguments: { product: "Breville Smart Kettle" } })!;
  assert.equal(r.result, undefined);
  assert.equal(r.error?.code, -32002);
  assert.match(r.error?.message ?? "", /initialize/);
  call("initialize", {});
});

test("the same call is answered once the handshake has happened", () => {
  resetSession();
  call("initialize", {});
  // and the session stays initialized for anything appended after this.
  const r = call("tools/call", { name: "recall_context", arguments: { product: "Breville Smart Kettle" } })!;
  assert.equal(r.error, undefined);
  assert.ok(Array.isArray((r.result as { content: unknown[] }).content));
});

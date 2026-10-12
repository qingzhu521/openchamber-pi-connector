import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBridge, extensionUiRequestFrom, parsePermissionTitle, type ApprovalEvent } from "../src/approvals.js";
import { PiRpcClient } from "../src/pi-rpc.js";
import { AdapterServer } from "../src/server.js";
import { V2EventTranslator } from "../src/v2.js";
import { EventEmitter } from "node:events";

const options = ["Allow once", "Allow always", "Deny", "Deny with feedback"];

function bounded<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function waitFor<T>(emitter: EventEmitter, event: string, ms = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      emitter.off("streamError", onError);
    };
    const onEvent = (value: T) => { cleanup(); resolve(value); };
    const onError = (error: unknown) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event} after ${ms}ms`));
    }, ms);
    emitter.once(event, onEvent);
    emitter.once("streamError", onError);
  });
}

function request(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
}

function harness() {
  const events: ApprovalEvent[] = [];
  const responses: Record<string, unknown>[] = [];
  const bridge = new ApprovalBridge("ses_test", (event) => events.push(event), (response) => responses.push(response), () => "msg_test");
  const ask = (value: Record<string, unknown>) => {
    const parsed = extensionUiRequestFrom(value);
    assert.ok(parsed);
    bridge.handle(parsed);
  };
  return { bridge, events, responses, ask };
}

test("question metadata and Other chain correlate even without RPC toolCallId", () => {
  const h = harness();
  h.bridge.noteToolStart("ask-call", "ask_user_question", { questions: [
    { question: "Pick?", header: "Original", options: [{ label: "A", description: "Detail" }] },
  ] });
  h.ask({ id: "select", method: "select", title: "Pick?", options: ["A", "Other (type an answer)"] });
  assert.equal(h.responses.length, 0);
  assert.equal(h.bridge.questions()[0]?.questions[0]?.header, "Original");
  assert.equal(h.bridge.questions()[0]?.questions[0]?.options[0]?.description, "Detail");
  h.bridge.replyQuestion("select", [["Custom"]]);
  h.ask({ id: "input", method: "input", title: "Your answer", timeout: 1800000 });
  h.ask({ id: "anything", method: "input", title: "Anything else? (optional)" });
  assert.deepEqual(h.responses, [
    { type: "extension_ui_response", id: "select", value: "Other (type an answer)" },
    { type: "extension_ui_response", id: "input", value: "Custom" },
  ]);
  assert.equal(h.bridge.questions().length, 1);
  h.bridge.rejectQuestion("anything");
  assert.deepEqual(h.responses.at(-1), { type: "extension_ui_response", id: "anything", cancelled: true });
});
test("confirm input editor and generic select produce their RPC response field", () => {
  for (const [method, answer, expected] of [
    ["confirm", "Yes", { confirmed: true }],
    ["confirm", "No", { confirmed: false }],
    ["input", "custom text", { value: "custom text" }],
    ["editor", "one\ntwo", { value: "one\ntwo" }],
    ["select", "Choice", { value: "Choice" }],
  ] as const) {
    const h = harness();
    h.ask({ id: "q", method, title: "Odd\nTitle", options: ["Choice"] });
    assert.equal(h.events[0]?.type, "question.asked");
    assert.equal(h.responses.length, 0);
    if (method === "input" || method === "editor") {
      assert.deepEqual(h.bridge.questions()[0]?.questions[0]?.options, []);
    }
    h.bridge.replyQuestion("q", [[answer]]);
    assert.deepEqual(h.responses, [{ type: "extension_ui_response", id: "q", ...expected }]);
  }
});

test("two pending requests reply out of order without cross-session access", () => {
  const h = harness();
  h.ask({ id: "p", method: "select", title: "Permission required: read", options, toolCallId: "call-1" });
  h.ask({ id: "q", method: "input", title: "Question", toolCallId: "call-2" });
  h.bridge.replyQuestion("q", [["Answer"]]);
  assert.equal(h.bridge.permissions().length, 1);
  assert.equal(h.bridge.replyPermission("p", "once", undefined, "different"), false);
  assert.equal(h.bridge.replyPermission("missing", "reject"), false);
  h.bridge.replyPermission("p", "once");
  assert.deepEqual(h.responses.map((r) => r.id), ["q", "p"]);
});

test("malformed answers and unknown labels never grant a tool", () => {
  const h = harness();
  h.ask({ id: "p", method: "select", title: "Permission required:", options: ["Unrecognized"] });
  assert.throws(() => h.bridge.replyPermission("p", "once"), /option unavailable/);
  h.ask({ id: "q", method: "select", title: "", options: ["Known"] });
  assert.throws(() => h.bridge.replyQuestion("q", [["Unknown"]]), /available option/);
  assert.throws(() => h.bridge.replyQuestion("q", []), /one question/);
  assert.equal(h.responses.length, 0);
  assert.equal(h.bridge.permissions().length, 1);
  assert.deepEqual(parsePermissionTitle("Permission required: eval\r\nTool: eval\r\nPatterns:\r\n - *\r\n - second\r\nExtra:"), {
    permission: "eval", patterns: ["*", "second"],
  });
  for (const method of ["setStatus", "setWidget", "notify", "setTitle", "setEditorText"]) {
    assert.equal(extensionUiRequestFrom({ id: method, method }), undefined);
  }
});

test("feedback cannot answer an unrelated tool and abort discards it", () => {
  const h = harness();
  h.ask({ id: "p", method: "select", title: "Permission required: edit", options, toolCallId: "edit" });
  h.bridge.replyPermission("p", "reject", "do not edit");
  h.ask({ id: "other", method: "input", title: "Other", toolCallId: "other" });
  assert.equal(h.responses.length, 1);
  h.bridge.cancelAll();
  h.ask({ id: "after", method: "input", toolCallId: "edit" });
  assert.equal(h.responses.length, 2);
  assert.equal(h.bridge.questions().length, 1);
});

test("turn end clears stale metadata and pending cards without cancellation", () => {
  const h = harness();
  h.bridge.noteToolStart("call", "ask_user_question", { questions: [{ question: "Pick", header: "Original", options: [] }] });
  h.ask({ id: "first", method: "select", title: "Pick", options: [] });
  h.bridge.finishTurn();
  assert.equal(h.events.at(-1)?.type, "question.rejected");
  assert.equal(h.responses.length, 0);
  h.ask({ id: "next", method: "select", title: "Pick", options: [] });
  assert.equal(h.bridge.questions()[0]?.questions[0]?.header, "Pick");
});

test("extension UI timeout clears the card on its rejection event", async () => {
  const responses: Record<string, unknown>[] = [];
  const events = new EventEmitter();
  const expired = waitFor(events, "question.rejected");
  const bridge = new ApprovalBridge("ses_test", (event) => events.emit(event.type, event),
    (response) => responses.push(response), () => "msg_test");
  try {
    const parsed = extensionUiRequestFrom({ id: "timeout", method: "input", title: "Timed", timeout: 1 });
    assert.ok(parsed);
    bridge.handle(parsed);
    await expired;
    assert.equal(responses.length, 0);
  } finally {
    bridge.cancelAll();
  }
});

test("v2 SSE permission uses native action resources source and event type", () => {
  const h = harness();
  h.ask({ id: "p", method: "select", title: "Permission required: read\nPatterns:\n - /tmp/x", options, toolCallId: "call" });
  const event = h.events[0];
  assert.ok(event);
  const frame = new V2EventTranslator().translate("/tmp", event)[0];
  assert.equal(frame?.type, "permission.v2.asked");
  assert.equal(frame?.data.action, "read");
  assert.deepEqual(frame?.data.resources, ["/tmp/x"]);
  assert.deepEqual(frame?.data.source, { type: "tool", messageID: "msg_test", callID: "call" });
});

test("real RPC transport forwards blocking requests without auto-cancellation", { timeout: 20000 }, async (t) => {
  const pi = new PiRpcClient({ cwd: tmpdir(), piBinary: new URL("./fixtures/approval-rpc.mjs", import.meta.url).pathname });
  t.after(() => bounded(pi.dispose(), "RPC process teardown", 10000));
  try {
    const emitted = waitFor<Record<string, unknown>>(pi, "extension_ui_request");
    const [, event] = await Promise.all([
      pi.command({ type: "emit_ui", request: { id: "blocking", method: "select", title: "Permission required: read", options } }, 5000),
      emitted,
    ]);
    assert.equal(event.id, "blocking");
    const before = await pi.command<{ responses: unknown[] }>({ type: "get_state" }, 5000);
    assert.deepEqual(before.data?.responses, []);
    pi.respondExtensionUI({ type: "extension_ui_response", id: "blocking", value: "Allow once" });
    const after = await pi.command<{ responses: unknown[] }>({ type: "get_state" }, 5000);
    assert.deepEqual(after.data?.responses, [{ type: "extension_ui_response", id: "blocking", value: "Allow once" }]);
  } finally {
    await bounded(pi.dispose(), "RPC process teardown", 10000);
  }
});

test("HTTP v1 v2 lists replies malformed input unknown IDs and abort", { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "approval-http-"));
  const keys = ["OCPI_PI_BINARY", "OCPI_STATE_DIR", "PI_CODING_AGENT_DIR"] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.OCPI_PI_BINARY = new URL("./fixtures/approval-rpc.mjs", import.meta.url).pathname;
  process.env.OCPI_STATE_DIR = root;
  process.env.PI_CODING_AGENT_DIR = root;
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  const signal = new AbortController();
  let reading: Promise<void> = Promise.resolve();
  t.after(() => {
    signal.abort();
    return bounded(server.stop(), "HTTP server teardown", 10000);
  });
  try {
    await bounded(server.start(), "HTTP server startup");
    const session = await (await request(`${server.url}/session`, { method: "POST", body: "{}" })).json() as { id: string };
    const stream = await bounded(fetch(`${server.url}/event`, { signal: signal.signal }), "SSE connection");
    const reader = stream.body?.getReader();
    assert.ok(reader);
    let buffer = "";
    const events = new EventEmitter();
    let streamError: unknown;
    reading = (async () => {
      try {
        for (;;) {
          const next = await bounded(reader.read(), "SSE frame");
          if (next.done) return;
          buffer += new TextDecoder().decode(next.value);
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith("data: ")) {
              const event = JSON.parse(frame.slice(6)) as { type: string };
              events.emit(event.type, event);
            }
          }
        }
      } catch (error) {
        if (!signal.signal.aborted) {
          streamError = error;
          events.emit("streamError", error);
        }
      }
    })();
    const asked = waitFor(events, "permission.asked");
    await Promise.all([
      request(`${server.url}/session/${session.id}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "permission" }] }) }),
      asked,
    ]);
    const pending = await (await request(`${server.url}/permission`)).json() as Array<{ id: string }>;
    assert.equal(pending.length, 1);
    const v2 = await (await request(`${server.url}/api/permission/request`)).json() as { data: Array<{ action: string; resources: string[] }> };
    assert.equal(v2.data[0]?.action, "read");
    assert.deepEqual(v2.data[0]?.resources, ["/tmp/fixture"]);
    assert.equal((await request(`${server.url}/permission/missing/reply`, { method: "POST", body: '{"reply":"once"}' })).status, 404);
    assert.equal((await request(`${server.url}/permission/${pending[0]?.id}/reply`, { method: "POST", body: '{"reply":"not-real"}' })).status, 400);
    const replied = waitFor(events, "permission.replied");
    const [reply] = await Promise.all([
      request(`${server.url}/api/session/${session.id}/permission/${pending[0]?.id}/reply`, { method: "POST", body: '{"reply":"once"}' }),
      replied,
    ]);
    assert.equal(reply.status, 204);
    assert.deepEqual(await (await request(`${server.url}/permission`)).json(), []);
    const questionAsked = waitFor(events, "question.asked");
    await Promise.all([
      request(`${server.url}/session/${session.id}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: "question" }] }) }),
      questionAsked,
    ]);
    const questions = await (await request(`${server.url}/api/question/request`)).json() as { data: Array<{ id: string }> };
    assert.equal(questions.data.length, 1);
    const rejected = waitFor(events, "question.rejected");
    await Promise.all([
      request(`${server.url}/session/${session.id}/abort`, { method: "POST" }),
      rejected,
    ]);
    assert.deepEqual(await (await request(`${server.url}/question`)).json(), []);
    assert.equal((await request(`${server.url}/question/missing/reject`, { method: "POST" })).status, 404);
    signal.abort();
    await bounded(reading, "SSE shutdown");
    assert.equal(streamError, undefined);
  } finally {
    signal.abort();
    try {
      await bounded(reading, "SSE shutdown");
    } finally {
      try {
        await bounded(server.stop(), "HTTP server teardown", 10000);
      } finally {
        keys.forEach((key, index) => {
          if (previous[index] === undefined) delete process.env[key];
          else process.env[key] = previous[index];
        });
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

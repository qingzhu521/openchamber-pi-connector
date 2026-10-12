import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalBridge,
  extensionUiRequestFrom,
  parsePermissionTitle,
  type ApprovalEvent,
  type ExtensionUiResponse,
} from "../src/approvals.js";

interface Harness {
  bridge: ApprovalBridge;
  events: ApprovalEvent[];
  responses: ExtensionUiResponse[];
}

function harness(): Harness {
  const events: ApprovalEvent[] = [];
  const responses: ExtensionUiResponse[] = [];
  return {
    events,
    responses,
    bridge: new ApprovalBridge("ses_test", (event) => events.push(event), (response) => responses.push(response), () => "msg_test"),
  };
}

function request(value: Record<string, unknown>) {
  const parsed = extensionUiRequestFrom(value);
  assert.ok(parsed, "request must be recognized as blocking");
  return parsed;
}

test("parses permission title Path File and Tool variants", () => {
  assert.deepEqual(parsePermissionTitle("Permission required: read\n\nPath: /tmp/a\n\nPatterns:\n  - /tmp/a"), {
    permission: "read",
    patterns: ["/tmp/a"],
  });
  assert.deepEqual(parsePermissionTitle("Permission required: edit\n\nFile: /tmp/a\n\nPatterns:\n  - /tmp/a"), {
    permission: "edit",
    patterns: ["/tmp/a"],
  });
  assert.deepEqual(parsePermissionTitle("Permission required: task\n\nTool: task\n\nPatterns:\n  - *"), {
    permission: "task",
    patterns: ["*"],
  });
});

test("classifies permission request without auto-cancelling", () => {
  const line = {
    id: "permission-read",
    method: "select",
    title: "Permission required: read\n\nPath: /tmp/work/seed.txt\n\nPatterns:\n  - /tmp/work/seed.txt",
    options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
    toolCallId: "call-read",
  };
  const h = harness();
  h.bridge.handle(request(line));
  assert.equal(h.responses.length, 0);
  assert.deepEqual(h.bridge.permissions()[0], {
    id: line.id,
    sessionID: "ses_test",
    permission: "read",
    patterns: ["/tmp/work/seed.txt"],
    metadata: { title: line.title },
    always: [],
    tool: { messageID: "msg_test", callID: line.toolCallId },
  });
});

test("maps every permission reply and feedback follow-up", () => {
  for (const [reply, expected] of [
    ["once", "Allow once"],
    ["always", "Allow always"],
    ["reject", "Deny"],
  ] as const) {
    const h = harness();
    h.bridge.handle(request({
      id: `p-${reply}`,
      method: "select",
      title: "Permission required: bash\n\nTool: bash\n\nPatterns:\n  - *",
      options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
      toolCallId: "call",
    }));
    assert.equal(h.bridge.replyPermission(`p-${reply}`, reply), true);
    assert.deepEqual(h.responses, [{ type: "extension_ui_response", id: `p-${reply}`, value: expected }]);
    assert.equal(h.events.at(-1)?.type, "permission.replied");
  }

  const h = harness();
  h.bridge.handle(request({
    id: "feedback",
    method: "select",
    title: "Permission required: bash",
    options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
    toolCallId: "call",
  }));
  assert.equal(h.bridge.replyPermission("feedback", "reject", "stop after listing files"), true);
  h.bridge.handle(request({ id: "feedback-input", method: "input", toolCallId: "call" }));
  assert.deepEqual(h.responses, [
    { type: "extension_ui_response", id: "feedback", value: "Deny with feedback" },
    { type: "extension_ui_response", id: "feedback-input", value: "stop after listing files" },
  ]);
  assert.equal(h.bridge.questions().length, 0);
});

test("maps ask_user_question select Other input and trailing input", () => {
  const h = harness();
  h.bridge.noteToolStart("ask-call", "ask_user_question", {
    questions: [
      {
        question: "Choose a color?",
        header: "Color",
        multiSelect: false,
        options: [{ label: "Blue", description: "Calm" }],
      },
    ],
  });
  h.bridge.handle(request({ id: "select", method: "select", title: "Choose a color?", options: ["Blue", "Other (type an answer)"], toolCallId: "ask-call" }));
  assert.deepEqual(h.bridge.questions()[0]?.questions[0], {
    question: "Choose a color?",
    header: "Color",
    options: [{ label: "Blue", description: "Calm" }],
    multiple: false,
    custom: true,
  });
  assert.equal(h.bridge.replyQuestion("select", [["Cerulean"]]), true);
  h.bridge.handle(request({ id: "custom-input", method: "input", toolCallId: "ask-call" }));
  h.bridge.handle(request({ id: "anything", method: "input", title: "Anything else? (optional)", toolCallId: "ask-call" }));
  assert.deepEqual(h.responses.slice(0, 2), [
    { type: "extension_ui_response", id: "select", value: "Other (type an answer)" },
    { type: "extension_ui_response", id: "custom-input", value: "Cerulean" },
  ]);
  assert.deepEqual(h.bridge.questions()[0]?.questions[0], {
    question: "Anything else? (optional)",
    header: "Anything else? (optional)",
    options: [],
    multiple: false,
    custom: true,
  });
  assert.equal(h.bridge.rejectQuestion("anything"), true);
  assert.deepEqual(h.responses.at(-1), { type: "extension_ui_response", id: "anything", cancelled: true });
});

test("cancel clears every pending request and ignores fire-and-forget UI", () => {
  const h = harness();
  assert.equal(extensionUiRequestFrom({ id: "status", method: "setStatus" }), undefined);
  h.bridge.handle(request({ id: "permission", method: "select", title: "Permission required: read" }));
  h.bridge.handle(request({ id: "input", method: "input", title: "Tell me" }));
  h.bridge.cancelAll();
  assert.deepEqual(h.responses, [
    { type: "extension_ui_response", id: "permission", cancelled: true },
    { type: "extension_ui_response", id: "input", cancelled: true },
  ]);
  assert.deepEqual(h.bridge.permissions(), []);
  assert.deepEqual(h.bridge.questions(), []);
});

test("tool terminal event clears stale pending card", () => {
  const h = harness();
  h.bridge.handle(request({ id: "pending", method: "input", title: "Question", toolCallId: "call" }));
  h.bridge.noteToolEnd("call");
  assert.deepEqual(h.bridge.questions(), []);
  assert.equal(h.events.at(-1)?.type, "question.rejected");
});

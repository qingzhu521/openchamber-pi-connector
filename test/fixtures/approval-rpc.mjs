#!/usr/bin/env node
import { randomUUID } from "node:crypto";

const responses = [];
const sessionId = randomUUID();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (command.type === "extension_ui_response") {
      responses.push(command);
      continue;
    }
    const data = command.type === "get_state"
      ? { sessionId, model: null, isStreaming: false, responses } : {};
    send({ type: "response", id: command.id, command: command.type, success: true, data });
    if (command.type === "emit_ui") send({ type: "extension_ui_request", ...command.request });
    if (command.type === "prompt") {
      send({ type: "agent_start" });
      const question = command.message === "question";
      send({
        type: "extension_ui_request", id: randomUUID(), toolCallId: "fixture-call",
        method: question ? "input" : "select",
        title: question ? "Answer?" : "Permission required: read\nPath: /tmp/fixture\nPatterns:\n - /tmp/fixture",
        options: question ? [] : ["Allow once", "Allow always", "Deny", "Deny with feedback"],
      });
    }
    if (command.type === "abort") send({ type: "agent_end" });
  }
});
process.stdin.on("end", () => process.exit(0));

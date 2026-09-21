/**
 * Session registry: one OpenCode session maps to one `pi --mode rpc` process.
 * Also owns the pi-event → OpenCode-event translation (the M1 "event bridge").
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { PiRpcClient } from "./pi-rpc.js";
import type {
  OCAssistantMessage,
  OCEvent,
  OCMessage,
  OCMessageWithParts,
  OCModelRef,
  OCPart,
  OCReasoningPart,
  OCSession,
  OCSessionStatus,
  OCTextPart,
  OCToolPart,
  OCToolStatePending,
  OCUserMessage,
} from "./types.js";

export const ADAPTER_VERSION = "0.1.0";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

interface StreamingState {
  message: OCAssistantMessage;
  /** contentIndex → part; pi addresses streaming content by index. */
  parts: Map<number, OCPart>;
}

export interface ManagedSession {
  info: OCSession;
  pi: PiRpcClient;
  messages: OCMessageWithParts[];
  status: OCSessionStatus;
  model: OCModelRef;
  streaming: StreamingState | undefined;
  /**
   * toolCallId → tool part for the current agent run. pi streams tool calls
   * (toolcall_start/delta/end) inside one assistant message but delivers the
   * *result* later, in turn_end.toolResults — matched by toolCallId.
   */
  toolByCallId: Map<string, OCToolPart>;
}

type EventSink = (directory: string, event: OCEvent) => void;

interface PiModel {
  id: string;
  provider: string;
  name?: string;
}

interface PiState {
  model: PiModel;
  sessionId: string;
  isStreaming: boolean;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();

  constructor(private emit: EventSink) {}

  async create(directory: string, title?: string, parentID?: string): Promise<OCSession> {
    const pi = new PiRpcClient({ cwd: directory });
    const state = await pi.command<PiState>({ type: "get_state" });
    if (!state.success || !state.data) {
      await pi.dispose();
      throw new Error(`pi get_state failed: ${state.error ?? "no data"}`);
    }

    const now = Date.now();
    const info: OCSession = {
      id: id("ses"),
      projectID: directory,
      directory,
      title: title ?? "New session",
      version: ADAPTER_VERSION,
      time: { created: now, updated: now },
      ...(parentID !== undefined ? { parentID } : {}),
    };

    const managed: ManagedSession = {
      info,
      pi,
      messages: [],
      status: { type: "idle" },
      model: { providerID: state.data.model.provider, modelID: state.data.model.id },
      streaming: undefined,
      toolByCallId: new Map(),
    };
    this.sessions.set(info.id, managed);

    pi.onEvent((payload) => this.onPiEvent(managed, payload));
    pi.onExit((code) => {
      this.setStatus(managed, { type: "idle" });
      this.emit(directory, {
        type: "session.error",
        properties: {
          sessionID: info.id,
          error: { name: "UnknownError", data: { message: `pi process exited (code=${code})` } },
        },
      });
    });

    this.emit(directory, { type: "session.created", properties: { info } });
    return info;
  }

  list(directory?: string): OCSession[] {
    const all = [...this.sessions.values()].map((s) => s.info);
    return directory === undefined ? all : all.filter((s) => s.directory === directory);
  }

  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  async remove(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.sessions.delete(sessionId);
    this.emit(s.info.directory, { type: "session.deleted", properties: { info: s.info } });
    await s.pi.dispose();
    return true;
  }

  rename(sessionId: string, title: string): OCSession | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.info.title = title;
    s.info.time.updated = Date.now();
    void s.pi.command({ type: "set_session_name", name: title }).catch(() => undefined);
    this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    return s.info;
  }

  messages(sessionId: string): OCMessageWithParts[] | undefined {
    return this.sessions.get(sessionId)?.messages;
  }

  statuses(): Record<string, OCSessionStatus> {
    const out: Record<string, OCSessionStatus> = {};
    for (const s of this.sessions.values()) out[s.info.id] = s.status;
    return out;
  }

  async abort(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    await s.pi.command({ type: "abort" }).catch(() => undefined);
    return true;
  }

  async prompt(sessionId: string, text: string, model?: OCModelRef, noReply = false, messageID?: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);

    if (model && (model.providerID !== s.model.providerID || model.modelID !== s.model.modelID)) {
      const res = await s.pi
        .command({ type: "set_model", provider: model.providerID, modelId: model.modelID })
        .catch(() => undefined);
      if (res?.success) s.model = model;
    }

    // OpenChamber sends a client-generated messageID with its optimistic
    // insert; the server MUST reuse it so the echoed message.part.updated /
    // message.updated events reconcile the optimistic entry in place instead
    // of rendering the user's message twice (event-reducer matches by id).
    const userMsg: OCUserMessage = {
      id: typeof messageID === "string" && messageID !== "" ? messageID : id("msg"),
      sessionID: s.info.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: s.model,
    };
    const parts: OCPart[] = [
      { id: id("prt"), sessionID: s.info.id, messageID: userMsg.id, type: "text", text },
    ];
    s.messages.push({ info: userMsg, parts });
    s.info.time.updated = Date.now();
    if (s.info.title === "New session") {
      s.info.title = text.slice(0, 60);
      this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    }
    this.emit(s.info.directory, { type: "message.updated", properties: { info: userMsg } });
    // Echo the user text part: the reducer replaces the client's sessionID-less
    // optimistic part (same type, new id) in place — without this echo a page
    // fetch merges the optimistic part back in and the text shows twice.
    for (const p of parts) this.emitPart(s, p);

    if (noReply) return; // register-only semantics: record the message, do not run the agent

    s.toolByCallId = new Map(); // results for this run arrive by toolCallId

    // pi streams asynchronously after accepting the prompt.
    const res = await s.pi.command({ type: "prompt", message: text });
    if (!res.success) {
      this.emit(s.info.directory, {
        type: "session.error",
        properties: {
          sessionID: s.info.id,
          error: { name: "UnknownError", data: { message: res.error ?? "prompt rejected" } },
        },
      });
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.pi.dispose()));
    this.sessions.clear();
  }

  // ------------------------------------------------------------------
  // pi event → OpenCode event translation
  // ------------------------------------------------------------------

  private setStatus(s: ManagedSession, status: OCSessionStatus): void {
    s.status = status;
    this.emit(s.info.directory, {
      type: "session.status",
      properties: { sessionID: s.info.id, status },
    });
  }

  private emitPart(s: ManagedSession, part: OCPart, delta?: string): void {
    this.emit(s.info.directory, {
      type: "message.part.updated",
      properties: delta === undefined ? { part } : { part, delta },
    });
  }

  private onPiEvent(s: ManagedSession, ev: Record<string, unknown>): void {
    const dir = s.info.directory;
    if (process.env.OCPI_DEBUG) {
      const ame = (ev.assistantMessageEvent as { type?: string } | undefined)?.type;
      const target = process.env.OCPI_DEBUG_LOG ?? "/tmp/openchamber-pi-debug.log";
      appendFileSync(target, `[pi-event] ${String(ev.type)}${ame ? `/${ame}` : ""} ${JSON.stringify(ev).slice(0, 300)}\n`);
    }
    switch (ev.type) {
      case "agent_start":
        this.setStatus(s, { type: "busy" });
        break;

      case "agent_end": {
        if (ev.willRetry === true) break; // auto-retry keeps the session busy
        this.finalizeDanglingTools(s);
        this.finishStreaming(s);
        this.setStatus(s, { type: "idle" });
        this.emit(dir, { type: "session.idle", properties: { sessionID: s.info.id } });
        break;
      }

      case "turn_end": {
        // pi delivers tool results here, matched back to parts by toolCallId.
        const results = ev.toolResults as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(results)) this.applyToolResults(s, results);
        break;
      }

      case "message_start": {
        const msg = ev.message as { role?: string } | undefined;
        if (msg?.role !== "assistant") break; // user message already recorded at prompt()
        const parent = [...s.messages].reverse().find((m) => m.info.role === "user");
        const assistant: OCAssistantMessage = {
          id: id("msg"),
          sessionID: s.info.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: parent?.info.id ?? "",
          modelID: s.model.modelID,
          providerID: s.model.providerID,
          mode: "build",
          path: { cwd: s.info.directory, root: s.info.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
        s.streaming = { message: assistant, parts: new Map() };
        s.messages.push({ info: assistant, parts: [] });
        this.emit(dir, { type: "message.updated", properties: { info: assistant } });
        break;
      }

      case "message_update":
        this.onMessageUpdate(s, ev);
        break;

      case "message_end": {
        const ended = ev.message as { role?: string; usage?: PiUsage } | undefined;
        if (ended?.role === "assistant" && s.streaming) {
          this.applyUsage(s.streaming.message, ended.usage);
          s.streaming.message.time.completed = Date.now();
          this.emit(dir, { type: "message.updated", properties: { info: s.streaming.message } });
          this.finishStreaming(s);
        }
        break;
      }

      case "auto_retry_start":
        this.setStatus(s, {
          type: "retry",
          attempt: Number(ev.attempt ?? 1),
          message: String(ev.errorMessage ?? "retrying"),
          next: Date.now() + Number(ev.delayMs ?? 0),
        });
        break;

      case "extension_error":
        this.emit(dir, {
          type: "session.error",
          properties: {
            sessionID: s.info.id,
            error: { name: "UnknownError", data: { message: String(ev.error ?? "pi extension error") } },
          },
        });
        break;

      default:
        break; // turn_start, queue_update, compaction_* — future milestones
    }
  }

  private finishStreaming(s: ManagedSession): void {
    if (s.streaming) s.streaming = undefined;
  }

  private onMessageUpdate(s: ManagedSession, ev: Record<string, unknown>): void {
    const streaming = s.streaming;
    if (!streaming) return;
    const ame = ev.assistantMessageEvent as
      | { type: string; contentIndex?: number; delta?: string; content?: string; id?: string; toolName?: string; toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> } }
      | undefined;
    if (!ame || ame.contentIndex === undefined) return;

    if (ame.type.startsWith("toolcall_")) {
      this.onToolcallEvent(s, ame);
      return;
    }

    const dir = s.info.directory;
    // `wire` is pi's content-block name (thinking_* / text_*); `kind` is the
    // OpenCode part type we translate it into. Keep the two separate: deriving
    // the delta/end event names from `kind` produced "reasoning_delta"/"reasoning_end",
    // which pi never emits, so thinking content was silently dropped.
    const wire = ame.type.startsWith("thinking") ? "thinking" : ame.type.startsWith("text") ? "text" : null;
    if (!wire) return; // start / done / error wrappers — no part content
    const kind: "text" | "reasoning" = wire === "thinking" ? "reasoning" : "text";

    let part = streaming.parts.get(ame.contentIndex);
    if (part !== undefined && part.type === "tool") return; // defensive: slot holds a tool part
    if (!part) {
      part = this.newPart(kind, s.info.id, streaming.message.id);
      streaming.parts.set(ame.contentIndex, part);
      const record = s.messages.find((m) => m.info.id === streaming.message.id);
      record?.parts.push(part);
      this.emitPart(s, part);
    }
    const textPart = part as OCTextPart | OCReasoningPart;

    if (ame.type === `${wire}_delta` && typeof ame.delta === "string") {
      textPart.text += ame.delta;
      this.emitPart(s, textPart, ame.delta);
    } else if (ame.type === `${wire}_end`) {
      if (typeof ame.content === "string") textPart.text = ame.content;
      if (textPart.time) textPart.time.end = Date.now();
      this.emitPart(s, textPart);
    }
    this.emit(dir, { type: "message.updated", properties: { info: streaming.message } });
  }

  /**
   * pi toolcall events → OpenCode tool parts (M2). Live-observed shapes
   * (probe, 2026-09-21):
   *   toolcall_start {contentIndex, id, toolName}
   *   toolcall_delta {contentIndex, delta}          — JSON argument fragments
   *   toolcall_end   {contentIndex, toolCall:{id, name, arguments}}
   * Results arrive separately in turn_end.toolResults
   * [{toolCallId, toolName, content:[{type:"text",text}], isError}].
   */
  private onToolcallEvent(
    s: ManagedSession,
    ame: { type: string; contentIndex?: number; delta?: string; id?: string; toolName?: string; toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> } },
  ): void {
    const streaming = s.streaming;
    if (!streaming || ame.contentIndex === undefined) return;
    const contentIndex = ame.contentIndex;
    const dir = s.info.directory;

    let part = streaming.parts.get(contentIndex) as OCToolPart | undefined;
    if (!part) {
      const callID = ame.toolCall?.id ?? ame.id ?? `call_${contentIndex}`;
      part = {
        id: id("prt"),
        sessionID: s.info.id,
        messageID: streaming.message.id,
        type: "tool",
        callID,
        tool: ame.toolCall?.name ?? ame.toolName ?? "unknown",
        state: { status: "pending", input: {}, raw: "" },
      };
      streaming.parts.set(contentIndex, part);
      const record = s.messages.find((m) => m.info.id === streaming.message.id);
      record?.parts.push(part);
    }

    if (ame.type === "toolcall_start") {
      this.emitPart(s, part);
      return;
    }

    if (ame.type === "toolcall_delta") {
      // Arguments stream as JSON fragments — accumulate in state.raw (the
      // OpenCode pending state is designed exactly for this).
      if (part.state.status === "pending" && typeof ame.delta === "string") {
        (part.state as OCToolStatePending).raw += ame.delta;
        this.emitPart(s, part);
      }
      return;
    }

    if (ame.type === "toolcall_end") {
      const args = ame.toolCall?.arguments ?? {};
      const callID = ame.toolCall?.id ?? part.callID;
      const name = ame.toolCall?.name ?? part.tool;
      part.callID = callID;
      part.tool = name;
      part.state = {
        status: "running",
        input: args,
        title: toolTitle(name, args),
        time: { start: Date.now() },
      };
      s.toolByCallId.set(callID, part);
      this.emitPart(s, part);
      this.emit(dir, { type: "message.updated", properties: { info: streaming.message } });
      return;
    }

    if (ame.type === "toolcall_error") {
      part.state = {
        status: "error",
        input: part.state.input ?? {},
        error: ame.delta ?? "tool call errored",
        time: { start: Date.now(), end: Date.now() },
      };
      this.emitPart(s, part);
    }
  }

  /** turn_end.toolResults → finalize tool parts (completed / error). */
  private applyToolResults(s: ManagedSession, results: Array<Record<string, unknown>>): void {
    for (const tr of results) {
      const callID = typeof tr.toolCallId === "string" ? tr.toolCallId : undefined;
      const part = callID !== undefined ? s.toolByCallId.get(callID) : undefined;
      if (!part || callID === undefined) continue;
      s.toolByCallId.delete(callID);
      const text = resultText(tr.content);
      const startedAt = part.state.status !== "pending" ? part.state.time.start : Date.now();
      const input = part.state.input ?? {};
      if (tr.isError === true) {
        part.state = {
          status: "error",
          input,
          error: text ?? `tool ${part.tool} failed`,
          time: { start: startedAt, end: Date.now() },
        };
      } else {
        part.state = {
          status: "completed",
          input,
          output: text ?? "",
          title: toolTitle(part.tool, input),
          metadata: {},
          time: { start: startedAt, end: Date.now() },
        };
      }
      this.emitPart(s, part);
      const owner = s.messages.find((m) => m.info.id === part.messageID);
      if (owner) this.emit(s.info.directory, { type: "message.updated", properties: { info: owner.info } });
    }
  }

  /** Tool parts that never received a result (abort, crash) must not spin forever. */
  private finalizeDanglingTools(s: ManagedSession): void {
    for (const part of s.toolByCallId.values()) {
      const startedAt = part.state.status !== "pending" ? part.state.time.start : Date.now();
      part.state = {
        status: "error",
        input: part.state.input ?? {},
        error: "run ended without a tool result",
        time: { start: startedAt, end: Date.now() },
      };
      this.emitPart(s, part);
    }
    s.toolByCallId.clear();
  }

  private newPart(kind: "text" | "reasoning", sessionID: string, messageID: string): OCPart {
    const base = {
      id: id("prt"),
      sessionID,
      messageID,
      text: "",
      time: { start: Date.now() },
    };
    return kind === "text"
      ? ({ ...base, type: "text" } satisfies OCTextPart)
      : ({ ...base, type: "reasoning" } satisfies OCReasoningPart);
  }

  private applyUsage(msg: OCAssistantMessage, usage: PiUsage | undefined): void {
    if (!usage) return;
    msg.tokens = {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      reasoning: usage.reasoning ?? 0,
      cache: { read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 },
    };
    if (usage.cost?.total !== undefined) msg.cost = usage.cost.total;
    if (usage.stopReason !== undefined) msg.finish = usage.stopReason;
  }
}

interface PiUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  stopReason?: string;
}

/** Human title: `bash: <command>` / `write: <path>`, else the tool name. */
function toolTitle(tool: string, args: Record<string, unknown>): string {
  const cmd = typeof args.command === "string" ? args.command : undefined;
  const path = typeof args.path === "string" ? args.path : undefined;
  const hint = cmd ?? path;
  if (hint === undefined) return tool;
  const short = hint.length > 60 ? `${hint.slice(0, 57)}…` : hint;
  return `${tool}: ${short}`;
}

/** pi toolResult content blocks → joined text. */
function resultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .join("");
  return text === "" ? undefined : text;
}

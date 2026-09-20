/**
 * Session registry: one OpenCode session maps to one `pi --mode rpc` process.
 * Also owns the pi-event → OpenCode-event translation (the M1 "event bridge").
 */

import { randomUUID } from "node:crypto";
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

  async prompt(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);

    const userMsg: OCUserMessage = {
      id: id("msg"),
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
    switch (ev.type) {
      case "agent_start":
        this.setStatus(s, { type: "busy" });
        break;

      case "agent_end": {
        if (ev.willRetry === true) break; // auto-retry keeps the session busy
        this.finishStreaming(s);
        this.setStatus(s, { type: "idle" });
        this.emit(dir, { type: "session.idle", properties: { sessionID: s.info.id } });
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
        break; // turn_start/turn_end, tool_*, queue_update, compaction_* — M2+
    }
  }

  private finishStreaming(s: ManagedSession): void {
    if (s.streaming) s.streaming = undefined;
  }

  private onMessageUpdate(s: ManagedSession, ev: Record<string, unknown>): void {
    const streaming = s.streaming;
    if (!streaming) return;
    const ame = ev.assistantMessageEvent as
      | { type: string; contentIndex?: number; delta?: string; content?: string }
      | undefined;
    if (!ame || ame.contentIndex === undefined) return;

    const dir = s.info.directory;
    const kind = ame.type.startsWith("thinking") ? "reasoning" : ame.type.startsWith("text") ? "text" : null;
    if (!kind) return; // toolcall_* / start / done / error — M2

    let part = streaming.parts.get(ame.contentIndex);
    if (!part) {
      part = this.newPart(kind, s.info.id, streaming.message.id);
      streaming.parts.set(ame.contentIndex, part);
      const record = s.messages.find((m) => m.info.id === streaming.message.id);
      record?.parts.push(part);
      this.emitPart(s, part);
    }

    if (ame.type === `${kind}_delta` && typeof ame.delta === "string") {
      part.text += ame.delta;
      this.emitPart(s, part, ame.delta);
    } else if (ame.type === `${kind}_end` && typeof ame.content === "string") {
      part.text = ame.content;
      if (part.time) part.time.end = Date.now();
      this.emitPart(s, part);
    }
    this.emit(dir, { type: "message.updated", properties: { info: streaming.message } });
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

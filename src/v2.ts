/**
 * opencode v2 API translation layer.
 *
 * NOTE: this file used to be kept byte-identical with openchamber-mcode's
 * v2.ts and no longer is — `model.changed` → `session.model.selected` and the
 * honest /api/model/default resolution are pi-side additions. Mirror them to
 * mcode only together with an equivalent `Catalog.default`; without it mcode
 * would lose its default-model resolution entirely.
 *
 * The connectors implement the v1 API natively (types.ts / sessions.ts). This
 * module reshapes that same data into the v2 wire contract that the OpenChamber
 * 2.0.4 web UI speaks:
 *
 *   - HTTP resources: v2 Session / Message (content blocks), the flattened
 *     model catalog served by /api/model, and the bootstrap Location/Info.
 *   - SSE: a stateful translator from the connector's internal OCEvent stream
 *     to the granular `session.*` envelope events (useAppFontEffects switch).
 *
 * The UI derives text/reasoning part ids from (assistantMessageID, ordinal) and
 * tool parts from the tool-call id. Ordinals are numbered per type within one
 * assistant message — exactly how the UI rebuilds a fetched message's `content`
 * array (index-CgR5rJq_ `Zh`).
 */

import { randomUUID } from "node:crypto";
import type { OCAssistantMessage, OCMessageWithParts, OCModelRef, OCPart, OCSession, OCSessionStatus, OCEvent } from "./types.js";

function genId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function subpathOf(directory: string): string {
  return directory.replace(/^\/+/, "");
}

function zeroTokens(): V2Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

// ---------------------------------------------------------------------
// v2 HTTP resource shapes
// ---------------------------------------------------------------------

export interface V2Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface V2Model {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: Array<{ id: string; settings: Record<string, unknown> }>;
  time: { released: number };
  cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>;
  status: string;
  enabled: boolean;
  limit: { context: number; output: number };
}

/**
 * Structural subset of each connector's Catalog (catalog.ts). Keeping it local
 * lets this file stay byte-identical between the mcode and pi repos.
 */
interface CatalogModelLike {
  id: string;
  providerID: string;
  name: string;
  capabilities: { input: Record<string, boolean> };
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; output: number };
}

interface CatalogProviderLike {
  id: string;
  name: string;
  models: Record<string, CatalogModelLike>;
}

export interface CatalogLike {
  providers: CatalogProviderLike[];
  defaults: Record<string, string>;
  /** The model the agent reported as active (see catalog.ts). */
  default?: { providerID: string; modelID: string };
}

function toV2Model(m: CatalogModelLike): V2Model {
  const inputs = Object.entries(m.capabilities.input)
    .filter(([, on]) => on === true)
    .map(([name]) => name);
  return {
    id: m.id,
    modelID: m.id,
    providerID: m.providerID,
    name: m.name,
    capabilities: { tools: true, input: inputs.length > 0 ? inputs : ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [{ input: m.cost.input, output: m.cost.output, cache: { read: m.cost.cache.read, write: m.cost.cache.write } }],
    status: "active",
    enabled: true,
    limit: { context: m.limit.context, output: m.limit.output },
  };
}

/** Flatten the per-provider model records into the v2 `/api/model` list. */
export function flattenModels(cat: CatalogLike): V2Model[] {
  const out: V2Model[] = [];
  for (const p of cat.providers) {
    for (const m of Object.values(p.models)) out.push(toV2Model(m));
  }
  return out;
}

/** The v2 `/api/model/default` model object — the model actually in use. */
export function defaultV2Model(cat: CatalogLike): V2Model | undefined {
  const lookup = (providerID: string, modelID: string): V2Model | undefined => {
    const provider = cat.providers.find((p) => p.id === providerID);
    const model = provider?.models[modelID];
    return model ? toV2Model(model) : undefined;
  };
  if (cat.default !== undefined) {
    const active = lookup(cat.default.providerID, cat.default.modelID);
    if (active !== undefined) return active;
  }
  for (const [providerID, modelID] of Object.entries(cat.defaults)) {
    const found = lookup(providerID, modelID);
    if (found !== undefined) return found;
  }
  // Deliberately no "first provider, first model" fallback: advertising a model
  // the agent is not running makes the client pin its picker to a lie, and
  // every prompt then re-asserts it. null is honest; the client copes.
  return undefined;
}

export interface V2Session {
  id: string;
  parentID?: string;
  projectID: string;
  agent: string;
  model?: { id: string; providerID: string; variant?: string };
  cost: number;
  tokens: V2Tokens;
  time: { created: number; updated: number; archived?: number };
  title: string;
  subpath: string;
  location: { directory: string };
}

export function toV2Session(
  info: OCSession,
  opts: { model?: OCModelRef | undefined; agent?: string | undefined } = {},
): V2Session {
  const session: V2Session = {
    id: info.id,
    projectID: info.projectID,
    agent: opts.agent ?? "build",
    cost: 0,
    tokens: zeroTokens(),
    time: {
      created: info.time.created,
      updated: info.time.updated,
      ...(info.time.archived !== undefined ? { archived: info.time.archived } : {}),
    },
    title: info.title,
    subpath: subpathOf(info.directory),
    location: { directory: info.directory },
  };
  if (info.parentID !== undefined) session.parentID = info.parentID;
  if (opts.model !== undefined) {
    session.model = { id: opts.model.modelID, providerID: opts.model.providerID };
  }
  return session;
}

export interface V2Message {
  id: string;
  time: { created: number; completed?: number; streamed?: number };
  type: "user" | "assistant";
  text?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  content?: Array<Record<string, unknown>>;
}

/** v2 user message (list + prompt response): the UI reads `.text`. */
export function toV2UserMessage(info: OCMessageWithParts): V2Message {
  const text = info.parts
    .filter((p): p is Extract<OCPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  return {
    id: info.info.id,
    time: { created: info.info.time.created },
    type: "user",
    text,
  };
}

/**
 * v2 assistant message: parts become `content` blocks. The UI rebuilds
 * text/reasoning part ids from per-type indices into this array.
 */
export function toV2AssistantMessage(info: OCMessageWithParts): V2Message {
  const i = info.info as OCAssistantMessage;
  const model = { id: i.modelID, providerID: i.providerID };
  const content: Array<Record<string, unknown>> = [];
  for (const part of info.parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "reasoning") {
      content.push({
        type: "reasoning",
        text: part.text,
        time: {
          ...(part.time?.start !== undefined ? { created: part.time.start } : {}),
          ...(part.time?.end !== undefined ? { completed: part.time.end } : {}),
        },
      });
    } else {
      content.push(toolContent(part));
    }
  }
  const msg: V2Message = { id: i.id, time: { created: i.time.created }, type: "assistant", content };
  if (i.time.completed !== undefined) msg.time.completed = i.time.completed;
  msg.agent = i.mode;
  msg.model = model;
  return msg;
}

function toolContent(part: Extract<OCPart, { type: "tool" }>): Record<string, unknown> {
  const st = part.state;
  const start = st.status === "pending" ? undefined : st.time.start;
  const end = st.status === "pending" || st.status === "running" ? undefined : st.time.end;
  const base: Record<string, unknown> = {
    type: "tool",
    id: part.callID,
    name: part.tool,
    // keep the SDK v1 spellings too — harmless and tolerates older readers
    callID: part.callID,
    tool: part.tool,
    executed: false,
    time: {
      ...(start !== undefined ? { created: start, ran: start } : {}),
      ...(end !== undefined ? { completed: end } : {}),
    },
  };
  if (st.status === "pending") {
    base.state = { status: "streaming", input: st.raw ?? "", metadata: {} };
  } else if (st.status === "running") {
    base.state = {
      status: "running",
      input: st.input,
      ...(st.title !== undefined ? { title: st.title } : {}),
      metadata: st.metadata ?? {},
    };
  } else if (st.status === "completed") {
    base.state = {
      status: "completed",
      input: st.input,
      content: st.output !== "" ? [{ type: "text", text: st.output }] : [],
      output: st.output,
      title: st.title,
      metadata: st.metadata ?? {},
    };
  } else {
    base.state = {
      status: "error",
      input: st.input,
      error: { message: st.error, type: "error" },
      metadata: st.metadata ?? {},
    };
  }
  return base;
}

export function toV2Message(info: OCMessageWithParts): V2Message {
  return info.info.role === "user" ? toV2UserMessage(info) : toV2AssistantMessage(info);
}

// ---------------------------------------------------------------------
// SSE event translation: OCEvent (v1) → v2 envelopes
// ---------------------------------------------------------------------

export interface V2Envelope {
  id: string;
  created: number;
  type: string;
  location: { directory: string };
  data: Record<string, unknown>;
}

interface StepState {
  sessionID: string;
  messageID: string;
  agent: string;
  model: { id: string; providerID: string };
  finish?: string;
  cost: number;
  tokens: V2Tokens;
  ended: boolean;
  streamed: boolean;
}

interface PartState {
  kind: "text" | "reasoning";
  ordinal: number;
  ended: boolean;
}

interface ToolState {
  callID: string;
  name: string;
  started: boolean;
  inputEnded: boolean;
  called: boolean;
  ended: boolean;
  raw: string;
}

interface SessionState {
  executionStarted: boolean;
  step?: StepState;
  parts: Map<string, PartState>;
  counters: Map<string, { text: number; reasoning: number }>;
  tools: Map<string, ToolState>;
}

/**
 * Stateful v1→v2 event translator. One instance per server; translate() is
 * called once per emitted OCEvent and the resulting frames are fanned out to
 * v2 SSE subscribers only.
 */
export class V2EventTranslator {
  private sessions = new Map<string, SessionState>();

  translate(directory: string, ev: OCEvent): V2Envelope[] {
    switch (ev.type) {
      case "session.created": {
        const info = ev.properties.info;
        return [
          this.frame(directory, "session.created", {
            sessionID: info.id,
            projectID: info.projectID,
            location: { directory: info.directory },
            subpath: subpathOf(info.directory),
            title: info.title,
          }),
        ];
      }
      case "session.updated": {
        const info = ev.properties.info;
        return [this.frame(directory, "session.renamed", { sessionID: info.id, title: info.title })];
      }
      case "session.deleted": {
        const info = ev.properties.info;
        this.sessions.delete(info.id);
        return [this.frame(directory, "session.deleted", { sessionID: info.id })];
      }
      case "session.status":
        return this.onStatus(directory, ev.properties.sessionID, ev.properties.status);
      case "session.idle": {
        const sessionID = ev.properties.sessionID;
        const st = this.sessions.get(sessionID);
        const frames: V2Envelope[] = [];
        if (st?.step && !st.step.ended) frames.push(...this.finalizeStep(directory, st.step));
        frames.push(this.frame(directory, "session.execution.succeeded", { sessionID }));
        frames.push(this.frame(directory, "session.idle", { sessionID }));
        this.sessions.delete(sessionID);
        return frames;
      }
      case "session.error": {
        const { sessionID, error } = ev.properties;
        const frames: V2Envelope[] = [];
        const st = sessionID !== undefined ? this.sessions.get(sessionID) : undefined;
        if (sessionID !== undefined && st?.step && !st.step.ended) {
          st.step.ended = true;
          frames.push(
            this.frame(directory, "session.step.failed", {
              sessionID,
              assistantMessageID: st.step.messageID,
              finish: st.step.finish ?? "error",
              error: error ?? { name: "UnknownError", data: { message: "session error" } },
              cost: st.step.cost,
              tokens: st.step.tokens,
            }),
          );
          this.sessions.delete(sessionID);
        }
        if (sessionID !== undefined) {
          frames.push(
            this.frame(directory, "session.execution.failed", {
              sessionID,
              error: error ?? { name: "UnknownError", data: { message: "session error" } },
            }),
          );
        }
        return frames;
      }
      case "message.updated":
        return this.onMessageUpdated(directory, ev.properties.info);
      case "message.part.updated":
        return this.onPartUpdated(directory, ev.properties.part, ev.properties.delta);
      case "model.changed": {
        const { sessionID, model, previous } = ev.properties;
        return [
          this.frame(directory, "session.model.selected", {
            sessionID,
            model: { id: model.modelID, providerID: model.providerID },
            ...(previous !== undefined ? { previous: { id: previous.modelID, providerID: previous.providerID } } : {}),
          }),
        ];
      }
      case "permission.asked": {
        const p = ev.properties;
        return [this.frame(directory, "permission.v2.asked", {
          id: p.id, sessionID: p.sessionID, action: p.permission,
          resources: p.patterns, save: p.always, metadata: p.metadata,
          ...(p.tool ? { source: { type: "tool", ...p.tool } } : {}),
        })];
      }
      case "permission.replied":
        return [this.frame(directory, "permission.v2.replied", ev.properties)];
      case "question.asked":
        return [this.frame(directory, "question.v2.asked", ev.properties)];
      case "question.replied":
        return [this.frame(directory, "question.v2.replied", ev.properties)];
      case "question.rejected":
        return [this.frame(directory, "question.v2.rejected", ev.properties)];
      default:
        return [];
    }
  }

  private onStatus(
    directory: string,
    sessionID: string,
    status: OCSessionStatus,
  ): V2Envelope[] {
    const frames: V2Envelope[] = [this.frame(directory, "session.status", { sessionID, status })];
    const st = this.state(sessionID);
    if (status.type === "busy" && !st.executionStarted) {
      st.executionStarted = true;
      frames.push(this.frame(directory, "session.execution.started", { sessionID }));
    }
    return frames;
  }

  private onMessageUpdated(directory: string, info: OCMessageWithParts["info"]): V2Envelope[] {
    if (info.role === "user") return []; // the UI inserts user messages optimistically
    const st = this.state(info.sessionID);
    const frames: V2Envelope[] = [];
    const isNew = st.step === undefined || st.step.messageID !== info.id;
    if (isNew) {
      if (st.step && !st.step.ended) frames.push(...this.finalizeStep(directory, st.step));
      const step: StepState = {
        sessionID: info.sessionID,
        messageID: info.id,
        agent: info.mode !== "" ? info.mode : "build",
        model: { id: info.modelID, providerID: info.providerID },
        cost: info.cost,
        tokens: info.tokens,
        ended: false,
        streamed: false,
      };
      if (info.finish !== undefined) step.finish = info.finish;
      st.step = step;
      frames.push(
        this.frame(directory, "session.step.started", {
          sessionID: info.sessionID,
          assistantMessageID: info.id,
          agent: step.agent,
          model: step.model,
        }),
      );
    } else if (st.step) {
      st.step.cost = info.cost;
      st.step.tokens = info.tokens;
      if (info.finish !== undefined) st.step.finish = info.finish;
      if (!st.step.streamed) {
        st.step.streamed = true;
        frames.push(this.frame(directory, "session.step.streamed", { sessionID: info.sessionID, assistantMessageID: info.id }));
      }
    }
    if (st.step && !st.step.ended && info.time.completed !== undefined) {
      if (info.finish !== undefined) st.step.finish = info.finish;
      frames.push(...this.finalizeStep(directory, st.step));
    }
    return frames;
  }

  private finalizeStep(directory: string, st: StepState): V2Envelope[] {
    if (st.ended) return [];
    st.ended = true;
    return [
      this.frame(directory, "session.usage.updated", { sessionID: st.sessionID, cost: st.cost, tokens: st.tokens }),
      this.frame(directory, "session.step.ended", {
        sessionID: st.sessionID,
        assistantMessageID: st.messageID,
        finish: st.finish ?? "stop",
        cost: st.cost,
        tokens: st.tokens,
      }),
    ];
  }

  private onPartUpdated(directory: string, part: OCPart, delta?: string): V2Envelope[] {
    return part.type === "tool"
      ? this.onToolPart(directory, part)
      : this.onTextPart(directory, part, delta);
  }

  private onTextPart(directory: string, part: Extract<OCPart, { type: "text" | "reasoning" }>, delta?: string): V2Envelope[] {
    const kind = part.type;
    const st = this.state(part.sessionID);
    const mid = part.messageID;
    const frames: V2Envelope[] = [];
    let ps = st.parts.get(part.id);
    if (!ps) {
      const counters = st.counters.get(mid) ?? { text: 0, reasoning: 0 };
      const ordinal = kind === "text" ? counters.text++ : counters.reasoning++;
      st.counters.set(mid, counters);
      ps = { kind, ordinal, ended: false };
      st.parts.set(part.id, ps);
      frames.push(
        this.frame(directory, `session.${kind}.started`, {
          sessionID: part.sessionID,
          assistantMessageID: mid,
          ordinal,
        }),
      );
    }
    if (typeof delta === "string" && delta !== "") {
      frames.push(
        this.frame(directory, `session.${kind}.delta`, {
          sessionID: part.sessionID,
          assistantMessageID: mid,
          ordinal: ps.ordinal,
          delta,
        }),
      );
    }
    if (!ps.ended && part.time?.end !== undefined) {
      ps.ended = true;
      frames.push(
        this.frame(directory, `session.${kind}.ended`, {
          sessionID: part.sessionID,
          assistantMessageID: mid,
          ordinal: ps.ordinal,
          text: part.text,
        }),
      );
    }
    return frames;
  }

  private onToolPart(directory: string, part: Extract<OCPart, { type: "tool" }>): V2Envelope[] {
    const st = this.state(part.sessionID);
    let ts = st.tools.get(part.id);
    if (!ts) {
      ts = { callID: part.callID, name: part.tool, started: false, inputEnded: false, called: false, ended: false, raw: "" };
      st.tools.set(part.id, ts);
    }
    ts.callID = part.callID;
    ts.name = part.tool;
    const frames: V2Envelope[] = [];
    const base = { sessionID: part.sessionID, assistantMessageID: part.messageID, id: part.callID };
    const state = part.state;

    if (state.status === "pending") {
      if (!ts.started) {
        ts.started = true;
        frames.push(this.frame(directory, "session.tool.input.started", { ...base, name: part.tool }));
      }
      const raw = state.raw ?? "";
      if (raw.length > ts.raw.length) {
        const chunk = raw.slice(ts.raw.length);
        ts.raw = raw;
        frames.push(this.frame(directory, "session.tool.input.delta", { ...base, delta: chunk }));
      }
      return frames;
    }

    if (!ts.started) {
      ts.started = true;
      frames.push(this.frame(directory, "session.tool.input.started", { ...base, name: part.tool }));
    }
    if (!ts.inputEnded) {
      ts.inputEnded = true;
      frames.push(this.frame(directory, "session.tool.input.ended", { ...base, text: ts.raw !== "" ? ts.raw : safeJson(state.input) }));
    }
    if (!ts.called) {
      ts.called = true;
      frames.push(this.frame(directory, "session.tool.called", { ...base, input: state.input, executed: false }));
    }

    if (!ts.ended && state.status === "completed") {
      ts.ended = true;
      frames.push(
        this.frame(directory, "session.tool.success", {
          ...base,
          content: state.output !== "" ? [{ type: "text", text: state.output }] : [],
          metadata: state.metadata ?? {},
          executed: false,
        }),
      );
    } else if (!ts.ended && state.status === "error") {
      ts.ended = true;
      frames.push(
        this.frame(directory, "session.tool.failed", {
          ...base,
          error: { message: state.error, type: "error" },
          content: [],
          metadata: state.metadata ?? {},
          executed: false,
        }),
      );
    }
    return frames;
  }

  private state(sessionID: string): SessionState {
    let st = this.sessions.get(sessionID);
    if (!st) {
      st = { executionStarted: false, parts: new Map(), counters: new Map(), tools: new Map() };
      this.sessions.set(sessionID, st);
    }
    return st;
  }

  private frame(directory: string, type: string, data: Record<string, unknown>): V2Envelope {
    return { id: genId("evt"), created: Date.now(), type, location: { directory }, data };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

/**
 * Session registry: one OpenCode session maps to one `pi --mode rpc` process.
 * Also owns the pi-event → OpenCode-event translation (the M1 "event bridge").
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PiRpcClient } from "./pi-rpc.js";
import { ApprovalBridge, extensionUiRequestFrom, type PendingPermission, type PendingQuestion } from "./approvals.js";
import { getAgentName } from "./agent-name.js";
import { ocIdFor, piSessionDir, piSessionsRootMtime, scanAllPiSessions, scanPiSessions, SessionStore, type ScannedSession } from "./session-store.js";
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
  /** undefined while dormant (restored from disk, no pi process spawned yet). */
  pi: PiRpcClient | undefined;
  /** undefined for dormant sessions until history is parsed from the JSONL. */
  messages: OCMessageWithParts[] | undefined;
  status: OCSessionStatus;
  /** undefined while dormant; resolved via get_state on create/revive. */
  model: OCModelRef | undefined;
  streaming: StreamingState | undefined;
  /**
   * toolCallId → tool part for the current agent run. pi streams tool calls
   * (toolcall_start/delta/end) inside one assistant message but delivers the
   * *result* later, in turn_end.toolResults — matched by toolCallId.
   */
  toolByCallId: Map<string, OCToolPart>;
  approvals?: ApprovalBridge;
  /** pi's own session id + file — the bridge to persistence/restore. */
  piSessionId?: string;
  piPath?: string;
  /** Set while dormant: revive() spawns pi with `--session <piPath>`. */
  restored?: { piSessionId: string; piPath: string };
}

type EventSink = (directory: string, event: OCEvent) => void;

interface PiModel {
  id: string;
  provider: string;
  name?: string;
}

interface PiState {
  /** pi reports `null` before a model is resolved. */
  model: PiModel | null;
  sessionId: string;
  sessionFile?: string;
  isStreaming: boolean;
}

/**
 * pi reports the requested `model` and, once the provider has answered, the
 * concrete `responseModel` it actually served. The latter is the truth.
 */
function piModelId(responseModel: unknown, model: unknown): unknown {
  return typeof responseModel === "string" && responseModel !== "" ? responseModel : model;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private readonly store: SessionStore;
  /** directory → last scan freshness (pi dir mtime + wall clock). */
  private scanCache = new Map<string, { mtimeMs: number; at: number }>();
  /** freshness of the all-directories scan (see listAll). */
  private scanAllCache: { mtimeMs: number; at: number } | undefined;

  constructor(
    private emit: EventSink,
    store?: SessionStore,
    private defaultDirectory?: string,
  ) {
    this.store = store ?? new SessionStore();
  }

  async create(directory: string, title?: string, parentID?: string): Promise<OCSession> {
    const pi = new PiRpcClient({ cwd: directory });
    const state = await pi.command<PiState>({ type: "get_state" });
    if (!state.success || !state.data) {
      await pi.dispose();
      throw new Error(`pi get_state failed: ${state.error ?? "no data"}`);
    }

    const now = Date.now();
    // Deterministic id derived from pi's session id, so a session keeps the
    // same OpenChamber id across adapter restarts (create once, restore later).
    const piSessionId = typeof state.data.sessionId === "string" && state.data.sessionId !== "" ? state.data.sessionId : undefined;
    const info: OCSession = {
      id: piSessionId !== undefined ? ocIdFor(piSessionId) : id("ses"),
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
      model: undefined,
      streaming: undefined,
      toolByCallId: new Map(),
      ...(piSessionId !== undefined ? { piSessionId } : {}),
    };
    managed.approvals = this.approvalsFor(managed);
    this.sessions.set(info.id, managed);
    this.wirePi(managed, pi);

    this.emit(directory, { type: "session.created", properties: { info } });
    // Announce pi's real model *after* session.created, so the client already
    // knows the session when the switch marker lands in its transcript.
    this.applyPiModel(managed, state.data.model?.provider, state.data.model?.id);

    // Bind pi's session file so the session survives adapter restarts. pi
    // reports the path directly; fall back to a background scan for older pi
    // versions, and re-bind after the first prompt (pi persists lazily).
    if (typeof state.data.sessionFile === "string" && state.data.sessionFile !== "") {
      managed.piPath = state.data.sessionFile;
      this.persistMeta(managed);
    } else if (piSessionId !== undefined) {
      void this.resolvePiFile(directory, piSessionId).then((piPath) => {
        if (piPath !== undefined && managed.piPath === undefined) {
          managed.piPath = piPath;
          this.persistMeta(managed);
        }
      });
    }

    return info;
  }

  private wirePi(s: ManagedSession, pi: PiRpcClient): void {
    pi.onEvent((payload) => this.onPiEvent(s, payload));
    pi.onExtensionUI((request) => {
      if (s.pi !== pi) return;
      const extensionRequest = extensionUiRequestFrom(request);
      if (extensionRequest !== undefined) s.approvals?.handle(extensionRequest);
    });
    pi.onExit((code) => {
      if (s.pi !== pi) return;
      s.approvals?.finishTurn();
      this.setStatus(s, { type: "idle" });
      this.emit(s.info.directory, {
        type: "session.error",
        properties: {
          sessionID: s.info.id,
          error: { name: "UnknownError", data: { message: `pi process exited (code=${code})` } },
        },
      });
    });
  }

  /** pi writes `<ts>_<sessionId>.jsonl` at startup — poll briefly for it. */
  private async resolvePiFile(directory: string, piSessionId: string): Promise<string | undefined> {
    const dir = piSessionDir(directory);
    const suffix = `_${piSessionId}.jsonl`;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        for (const name of readdirSync(dir)) {
          if (name.endsWith(suffix)) return join(dir, name);
        }
      } catch {
        /* session dir may not exist until pi writes the first entry */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return undefined;
  }

  list(directory?: string): OCSession[] {
    if (directory !== undefined) {
      this.ensureScanned(directory);
      return [...this.sessions.values()].map((s) => s.info).filter((s) => s.directory === directory);
    }
    // Unfiltered: keep the old semantics — live sessions only.
    return [...this.sessions.values()].filter((s) => s.restored === undefined).map((s) => s.info);
  }

  /**
   * Every restorable session on disk (all directories) plus live ones. Backs the
   * directory-less `/experimental/session` list OpenChamber reads for its
   * global/recent view; `list(directory)` stays the per-project source of truth.
   */
  listAll(): OCSession[] {
    this.ensureAllScanned();
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(sessionId: string): ManagedSession | undefined {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;
    return this.resolveRestored(sessionId);
  }

  async remove(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId);
    if (!s) return false;
    s.approvals?.cancelAll();
    this.sessions.delete(sessionId);
    this.emit(s.info.directory, { type: "session.deleted", properties: { info: s.info } });
    if (s.pi !== undefined) await s.pi.dispose();
    const piPath = s.piPath ?? s.restored?.piPath;
    if (piPath !== undefined) {
      try {
        unlinkSync(piPath);
      } catch {
        /* file already gone — deleting the registry entry is enough */
      }
    }
    this.store.remove(sessionId);
    return true;
  }

  /**
   * PATCH /session/{id} — rename and/or archive. OpenChamber archives with
   * `{ time: { archived: Date.now() } }` and unarchives with `archived: 0`
   * (SDK v2 session.update); `title` is only touched when actually sent,
   * otherwise an archive-only PATCH would blank the title.
   */
  update(sessionId: string, patch: { title?: string | undefined; archived?: number | undefined }): OCSession | undefined {
    const s = this.get(sessionId);
    if (!s) return undefined;
    if (typeof patch.title === "string" && patch.title !== "") s.info.title = patch.title;
    if (patch.archived !== undefined) {
      if (patch.archived > 0) s.info.time.archived = patch.archived;
      else delete s.info.time.archived; // 0 = unarchive
    }
    s.info.time.updated = Date.now();
    this.persistMeta(s);
    if (typeof patch.title === "string" && patch.title !== "" && s.pi !== undefined) {
      void s.pi.command({ type: "set_session_name", name: patch.title }).catch(() => undefined);
    }
    this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    return s.info;
  }

  messages(sessionId: string): OCMessageWithParts[] | undefined {
    const s = this.get(sessionId);
    if (!s) return undefined;
    return this.ensureMessages(s);
  }

  statuses(): Record<string, OCSessionStatus> {
    const out: Record<string, OCSessionStatus> = {};
    for (const s of this.sessions.values()) out[s.info.id] = s.status; // dormant sessions are idle
    return out;
  }

  async abort(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId);
    if (!s) return false;
    if (s.pi === undefined) return true; // dormant sessions are idle by definition
    s.approvals?.cancelAll();
    await s.pi.command({ type: "abort" }).catch(() => undefined);
    return true;
  }

  permissions(sessionId?: string): PendingPermission[] {
    return [...this.sessions.values()].flatMap((session) => (sessionId === undefined || session.info.id === sessionId ? session.approvals?.permissions() ?? [] : []));
  }

  questions(sessionId?: string): PendingQuestion[] {
    return [...this.sessions.values()].flatMap((session) => (sessionId === undefined || session.info.id === sessionId ? session.approvals?.questions() ?? [] : []));
  }

  replyPermission(sessionID: string, requestID: string, reply: "once" | "always" | "reject", message?: string): boolean {
    return this.get(sessionID)?.approvals?.replyPermission(requestID, reply, message) ?? false;
  }

  replyQuestion(sessionID: string, requestID: string, answers: Array<string[]>): boolean {
    return this.get(sessionID)?.approvals?.replyQuestion(requestID, answers) ?? false;
  }

  rejectQuestion(sessionID: string, requestID: string): boolean {
    return this.get(sessionID)?.approvals?.rejectQuestion(requestID) ?? false;
  }

  private approvalsFor(s: ManagedSession): ApprovalBridge {
    return new ApprovalBridge(
      s.info.id,
      (event) => this.emit(s.info.directory, event as OCEvent),
      (response) => s.pi?.respondExtensionUI(response),
      () => s.streaming?.message.id ?? [...(s.messages ?? [])].reverse().find((m) => m.info.role === "assistant")?.info.id,
    );
  }

  /**
   * POST /api/session/{id}/model — OpenChamber awaits this before every prompt
   * (its `applySendSelection` calls switchModel first), so it is the only path
   * from the bottom-right picker to pi. Errors are deliberately not swallowed:
   * a silent no-op is exactly what let the UI and pi disagree about the model.
   */
  async setModel(sessionId: string, ref: OCModelRef): Promise<OCModelRef> {
    const s = this.get(sessionId);
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`);
    if (s.pi === undefined) await this.revive(s);
    const pi = s.pi;
    if (pi === undefined) throw new Error(`session cannot be resumed: ${sessionId}`);
    // The client re-sends its selection on every send; an unchanged model must
    // not cost a round-trip nor emit a phantom "model switched" marker.
    if (s.model !== undefined && s.model.providerID === ref.providerID && s.model.modelID === ref.modelID) {
      return s.model;
    }
    const res = await pi.command<{ provider?: string; id?: string; responseModel?: string }>({
      type: "set_model",
      provider: ref.providerID,
      modelId: ref.modelID,
    });
    if (!res.success) throw new Error(res.error ?? `pi refused model ${ref.providerID}/${ref.modelID}`);
    // pi's response is the authority, not the request: it echoes the resolved
    // Model, including `responseModel` when the provider named a concrete one.
    const data = res.data;
    const resolved: OCModelRef = {
      providerID: typeof data?.provider === "string" && data.provider !== "" ? data.provider : ref.providerID,
      modelID:
        typeof data?.responseModel === "string" && data.responseModel !== ""
          ? data.responseModel
          : typeof data?.id === "string" && data.id !== ""
            ? data.id
            : ref.modelID,
    };
    this.applyPiModel(s, resolved.providerID, resolved.modelID);
    return resolved;
  }

  /**
   * Single funnel for "pi is now running this model": adopt it, persist it for
   * the next cold start, and tell the UI. Returns whether anything changed.
   */
  private applyPiModel(s: ManagedSession, provider: unknown, modelId: unknown): boolean {
    if (typeof provider !== "string" || provider === "") return false;
    if (typeof modelId !== "string" || modelId === "") return false;
    const previous = s.model;
    if (previous !== undefined && previous.providerID === provider && previous.modelID === modelId) return false;
    const model: OCModelRef = { providerID: provider, modelID: modelId };
    s.model = model;
    this.persistMeta(s);
    this.emit(s.info.directory, {
      type: "model.changed",
      properties: { sessionID: s.info.id, model, ...(previous !== undefined ? { previous } : {}) },
    });
    return true;
  }

  async prompt(sessionId: string, text: string, model?: OCModelRef, noReply = false, messageID?: string): Promise<void> {
    const s = this.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    if (s.pi === undefined) await this.revive(s);
    const pi = s.pi;
    if (pi === undefined) throw new Error(`session cannot be resumed: ${sessionId}`);
    this.ensureMessages(s);

    // Same funnel as POST /api/session/{id}/model. Failing loudly matters: the
    // previous code swallowed pi's refusal and then reported the *requested*
    // model as though the switch had happened.
    if (model !== undefined) {
      try {
        await this.setModel(sessionId, model);
      } catch (err) {
        this.emit(s.info.directory, {
          type: "session.error",
          properties: {
            sessionID: s.info.id,
            error: { name: "UnknownError", data: { message: err instanceof Error ? err.message : String(err) } },
          },
        });
        throw err;
      }
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
      agent: getAgentName(),
      model: s.model ?? model ?? { providerID: "unknown", modelID: "unknown" },
    };
    const parts: OCPart[] = [
      { id: id("prt"), sessionID: s.info.id, messageID: userMsg.id, type: "text", text },
    ];
    s.messages?.push({ info: userMsg, parts });
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
    const res = await pi.command({ type: "prompt", message: text });
    if (!res.success) {
      this.emit(s.info.directory, {
        type: "session.error",
        properties: {
          sessionID: s.info.id,
          error: { name: "UnknownError", data: { message: res.error ?? "prompt rejected" } },
        },
      });
      return;
    }

    // First message makes pi write the session file — bind it now so the
    // session (and its current title) survives an adapter restart.
    if (s.piPath === undefined && s.piSessionId !== undefined) {
      const piPath = await this.resolvePiFile(s.info.directory, s.piSessionId);
      if (piPath !== undefined) {
        s.piPath = piPath;
        this.persistMeta(s);
      }
    }
  }

  async disposeAll(): Promise<void> {
    for (const s of this.sessions.values()) s.approvals?.cancelAll();
    await Promise.all(
      [...this.sessions.values()].map((s) => (s.pi !== undefined ? s.pi.dispose() : Promise.resolve())),
    );
    this.sessions.clear();
  }

  // ------------------------------------------------------------------
  // restore: dormant sessions backed by pi's JSONL files
  // ------------------------------------------------------------------

  /** Spawn pi against the session's JSONL file and adopt it as live. */
  private async revive(s: ManagedSession): Promise<void> {
    const restored = s.restored;
    if (restored === undefined) throw new Error(`session is not restorable: ${s.info.id}`);
    if (!existsSync(restored.piPath)) throw new Error(`pi session file is gone: ${restored.piPath}`);
    const pi = new PiRpcClient({ cwd: s.info.directory, args: ["--session", restored.piPath] });
    const state = await pi.command<PiState>({ type: "get_state" });
    if (!state.success || !state.data) {
      await pi.dispose();
      throw new Error(`pi get_state failed on resume: ${state.error ?? "no data"}`);
    }
    s.pi = pi;
    s.piPath = restored.piPath;
    s.piSessionId = restored.piSessionId;
    delete s.restored;
    s.approvals = this.approvalsFor(s);
    // A restored session pushes pi's real model to the UI rather than leaving
    // the picker on whatever it last showed for this directory.
    this.applyPiModel(s, state.data.model?.provider, state.data.model?.id);
    this.ensureMessages(s);
    this.wirePi(s, pi);
    this.persistMeta(s);
  }

  private ensureMessages(s: ManagedSession): OCMessageWithParts[] {
    if (s.messages === undefined) s.messages = parsePiSessionFile(s, getAgentName());
    return s.messages;
  }

  /** pi paths/ids already represented in memory — shared by both scans. */
  private knownSessionKeys(): { paths: Set<string>; piIds: Set<string> } {
    const paths = new Set<string>();
    const piIds = new Set<string>();
    for (const s of this.sessions.values()) {
      const p = s.piPath ?? s.restored?.piPath;
      if (p !== undefined) paths.add(p);
      if (s.piSessionId !== undefined) piIds.add(s.piSessionId);
      if (s.restored !== undefined) piIds.add(s.restored.piSessionId);
    }
    return { paths, piIds };
  }

  /** Adopt dormant sessions for pi files in `directory` not tracked yet. */
  private ensureScanned(directory: string): void {
    const dirPath = piSessionDir(directory);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(dirPath).mtimeMs;
    } catch {
      return; // no sessions recorded for this directory yet
    }
    const cached = this.scanCache.get(directory);
    if (cached !== undefined && cached.mtimeMs === mtimeMs && Date.now() - cached.at < 5_000) return;
    this.scanCache.set(directory, { mtimeMs, at: Date.now() });

    const { paths, piIds } = this.knownSessionKeys();
    for (const sc of scanPiSessions(directory)) {
      if (paths.has(sc.piPath) || piIds.has(sc.piSessionId)) continue;
      this.adopt(sc);
    }
  }

  /** Adopt every restorable pi session on disk, regardless of directory. */
  private ensureAllScanned(): void {
    const mtimeMs = piSessionsRootMtime();
    if (mtimeMs === undefined) return; // no sessions recorded yet
    const cached = this.scanAllCache;
    if (cached !== undefined && cached.mtimeMs === mtimeMs && Date.now() - cached.at < 5_000) return;
    this.scanAllCache = { mtimeMs, at: Date.now() };

    const { paths, piIds } = this.knownSessionKeys();
    for (const sc of scanAllPiSessions()) {
      if (paths.has(sc.piPath) || piIds.has(sc.piSessionId)) continue;
      this.adopt(sc);
    }
  }

  private adopt(sc: ScannedSession): ManagedSession {
    const ocId = ocIdFor(sc.piSessionId);
    const reg = this.store.get(ocId);
    const info: OCSession = {
      id: ocId,
      projectID: sc.directory,
      directory: sc.directory,
      title: reg?.title ?? sc.title,
      version: ADAPTER_VERSION,
      time: {
        created: sc.created,
        updated: Math.max(sc.updated, reg?.updated ?? 0),
        ...(reg?.archived ? { archived: reg.archived } : {}),
      },
    };
    const managed: ManagedSession = {
      info,
      pi: undefined,
      messages: undefined,
      status: { type: "idle" },
      model: reg?.model !== undefined ? { providerID: reg.model.providerID, modelID: reg.model.modelID } : undefined,
      streaming: undefined,
      toolByCallId: new Map(),
      restored: { piSessionId: sc.piSessionId, piPath: sc.piPath },
    };
    this.sessions.set(ocId, managed);
    return managed;
  }

  /** Resolve a bare session id (e.g. deep link after restart) via known directories. */
  private resolveRestored(sessionId: string): ManagedSession | undefined {
    const dirs = new Set<string>([
      ...this.store.directories(),
      ...[...this.sessions.values()].map((s) => s.info.directory),
    ]);
    if (this.defaultDirectory !== undefined) dirs.add(this.defaultDirectory);
    for (const dir of dirs) {
      this.ensureScanned(dir);
      const hit = this.sessions.get(sessionId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** Registry write for adapter-owned metadata (title override, pi path). */
  private persistMeta(s: ManagedSession): void {
    const piPath = s.piPath ?? s.restored?.piPath;
    const piSessionId = s.piSessionId ?? s.restored?.piSessionId;
    if (piPath === undefined || piSessionId === undefined) return;
    this.store.set(s.info.id, {
      piSessionId,
      piPath,
      directory: s.info.directory,
      // "New session" is a placeholder — let the scan-derived title win.
      ...(s.info.title !== "New session" ? { title: s.info.title } : {}),
      ...(s.info.time.archived !== undefined ? { archived: s.info.time.archived } : {}),
      ...(s.model !== undefined ? { model: { providerID: s.model.providerID, modelID: s.model.modelID } } : {}),
      created: s.info.time.created,
      updated: s.info.time.updated,
    });
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
        s.approvals?.finishTurn();
        this.finalizeDanglingTools(s);
        this.finishStreaming(s);
        this.setStatus(s, { type: "idle" });
        this.emit(dir, { type: "session.idle", properties: { sessionID: s.info.id } });
        if (s.piPath !== undefined) this.store.update(s.info.id, { updated: Date.now() });
        break;
      }

      case "turn_end": {
        s.approvals?.finishTurn();
        // pi delivers tool results here, matched back to parts by toolCallId.
        const results = ev.toolResults as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(results)) this.applyToolResults(s, results);
        break;
      }

      case "tool_execution_start":
        if (typeof ev.toolCallId === "string" && typeof ev.toolName === "string") {
          const approvals = s.approvals;
          approvals?.noteToolStart(ev.toolCallId, ev.toolName, ev.args);
        }
        break;

      case "tool_execution_end":
        if (typeof ev.toolCallId === "string") {
          const approvals = s.approvals;
          approvals?.noteToolEnd(ev.toolCallId);
        }
        break;

      case "message_start": {
        const msg = ev.message as { role?: string; provider?: unknown; model?: unknown; responseModel?: unknown } | undefined;
        if (msg?.role !== "assistant") break; // user message already recorded at prompt()
        // pi stamps the assistant message with the model really serving it.
        // Trust that over our snapshot, which goes stale whenever pi switches on
        // its own side (subagent routing, an in-session /model, a resumed file).
        this.applyPiModel(s, msg.provider, piModelId(msg.responseModel, msg.model));
        const parent = [...(s.messages ?? [])].reverse().find((m) => m.info.role === "user");
        const assistant: OCAssistantMessage = {
          id: id("msg"),
          sessionID: s.info.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: parent?.info.id ?? "",
          modelID: s.model?.modelID ?? "unknown",
          providerID: s.model?.providerID ?? "unknown",
          mode: getAgentName(),
          path: { cwd: s.info.directory, root: s.info.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
        s.streaming = { message: assistant, parts: new Map() };
        s.messages?.push({ info: assistant, parts: [] });
        this.emit(dir, { type: "message.updated", properties: { info: assistant } });
        break;
      }

      case "message_update":
        this.onMessageUpdate(s, ev);
        break;

      case "message_end": {
        const ended = ev.message as { role?: string; usage?: PiUsage; provider?: unknown; model?: unknown; responseModel?: unknown } | undefined;
        if (ended?.role === "assistant" && s.streaming) {
          // Last chance to correct attribution: some providers only reveal the
          // concrete model once the stream has closed.
          if (this.applyPiModel(s, ended.provider, piModelId(ended.responseModel, ended.model)) && s.model !== undefined) {
            s.streaming.message.providerID = s.model.providerID;
            s.streaming.message.modelID = s.model.modelID;
          }
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
      const record = s.messages?.find((m) => m.info.id === streaming.message.id);
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
      const record = s.messages?.find((m) => m.info.id === streaming.message.id);
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
      const owner = s.messages?.find((m) => m.info.id === part.messageID);
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

// ----------------------------------------------------------------------
// Restored-session history: pi JSONL file → OpenCode messages + parts
// ----------------------------------------------------------------------

interface PiFileEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  provider?: string;
  modelId?: string;
  message?: PiFileMessage;
}

interface PiFileMessage {
  role?: string;
  content?: Array<Record<string, unknown>>;
  usage?: PiUsage;
  provider?: string;
  model?: string;
  stopReason?: string;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

function entryTime(e: PiFileEntry): number {
  if (typeof e.timestamp === "number") return e.timestamp;
  if (typeof e.timestamp === "string") {
    const t = Date.parse(e.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof e.message?.timestamp === "number") return e.message.timestamp;
  return 0;
}

function textOf(content: Array<Record<string, unknown>> | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}

/**
 * Rebuild OpenCode messages from a pi session file for a dormant session.
 * pi entries form a tree (id/parentId); the active branch is the walk from
 * the newest message entry up to the root. Part ids are deterministic
 * (`prt_r<entry>_<block>`) so re-parsing reconciles in the UI instead of
 * duplicating. Never throws: unreadable/corrupt input degrades to [].
 */
function parsePiSessionFile(s: ManagedSession, agentName: string): OCMessageWithParts[] {
  const piPath = s.piPath ?? s.restored?.piPath;
  if (piPath === undefined) return [];
  const sessionID = s.info.id;
  const directory = s.info.directory;
  let raw: string;
  try {
    raw = readFileSync(piPath, "utf8");
  } catch {
    return [];
  }

  const entries: PiFileEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as PiFileEntry);
    } catch {
      /* torn trailing write — ignore */
    }
  }

  const indexOf = new Map<PiFileEntry, number>();
  entries.forEach((e, i) => indexOf.set(e, i));
  const byId = new Map<string, PiFileEntry>();
  for (const e of entries) if (typeof e.id === "string") byId.set(e.id, e);

  let leaf: PiFileEntry | undefined;
  for (const e of entries) {
    if (e.type !== "message") continue;
    if (leaf === undefined || entryTime(e) >= entryTime(leaf)) leaf = e;
  }
  const chain: PiFileEntry[] = [];
  const seen = new Set<PiFileEntry>();
  for (let cur = leaf; cur !== undefined && !seen.has(cur); ) {
    seen.add(cur);
    chain.push(cur);
    cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();

  const out: OCMessageWithParts[] = [];
  const toolParts = new Map<string, OCToolPart>();
  let currentModel: OCModelRef = { providerID: "unknown", modelID: "unknown" };
  let lastUserId = "";

  for (const e of chain) {
    if (e.type === "model_change" && typeof e.provider === "string" && typeof e.modelId === "string") {
      currentModel = { providerID: e.provider, modelID: e.modelId };
      continue;
    }
    if (e.type !== "message") continue;
    const m = e.message;
    if (m === undefined) continue;
    const idx = indexOf.get(e) ?? 0;
    const created = entryTime(e);

    if (m.role === "user") {
      const text = textOf(m.content);
      if (text === "") continue;
      const msgId = `msg_r${idx}`;
      lastUserId = msgId;
      const info: OCUserMessage = {
        id: msgId,
        sessionID,
        role: "user",
        time: { created },
        agent: agentName,
        model: currentModel,
      };
      const parts: OCPart[] = [
        { id: `prt_r${idx}_0`, sessionID, messageID: msgId, type: "text", text, time: { start: created, end: created } },
      ];
      out.push({ info, parts });
      continue;
    }

    if (m.role === "assistant") {
      if (typeof m.provider === "string" && typeof m.model === "string") {
        currentModel = { providerID: m.provider, modelID: m.model };
      }
      const msgId = `msg_r${idx}`;
      const info: OCAssistantMessage = {
        id: msgId,
        sessionID,
        role: "assistant",
        time: { created, completed: created },
        parentID: lastUserId,
        modelID: currentModel.modelID,
        providerID: currentModel.providerID,
        mode: agentName,
        path: { cwd: directory, root: directory },
        cost: m.usage?.cost?.total ?? 0,
        tokens: {
          input: m.usage?.input ?? 0,
          output: m.usage?.output ?? 0,
          reasoning: m.usage?.reasoning ?? 0,
          cache: { read: m.usage?.cacheRead ?? 0, write: m.usage?.cacheWrite ?? 0 },
        },
        ...(typeof m.stopReason === "string" ? { finish: m.stopReason } : {}),
      };
      const parts: OCPart[] = [];
      const blocks = Array.isArray(m.content) ? m.content : [];
      blocks.forEach((block, b) => {
        const partId = `prt_r${idx}_${b}`;
        const kind = block?.type;
        if (kind === "text" && typeof block.text === "string") {
          parts.push({ id: partId, sessionID, messageID: msgId, type: "text", text: block.text, time: { start: created, end: created } });
        } else if (kind === "thinking" && typeof block.thinking === "string") {
          parts.push({ id: partId, sessionID, messageID: msgId, type: "reasoning", text: block.thinking, time: { start: created, end: created } });
        } else if (kind === "toolCall") {
          const callID = typeof block.id === "string" ? block.id : `call_r${idx}_${b}`;
          const tool = typeof block.name === "string" ? block.name : "unknown";
          const args = block.arguments;
          const input = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
          const part: OCToolPart = {
            id: partId,
            sessionID,
            messageID: msgId,
            type: "tool",
            callID,
            tool,
            state: { status: "running", input, title: toolTitle(tool, input), time: { start: created } },
          };
          toolParts.set(callID, part);
          parts.push(part);
        }
      });
      out.push({ info, parts });
      continue;
    }

    if (m.role === "toolResult") {
      const callID = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
      const part = callID !== undefined ? toolParts.get(callID) : undefined;
      if (part === undefined) continue; // result without a visible call (abandoned branch)
      const text = resultText(m.content) ?? "";
      const startedAt = part.state.status !== "pending" ? part.state.time.start : created;
      const input = part.state.input ?? {};
      part.state =
        m.isError === true
          ? { status: "error", input, error: text !== "" ? text : `tool ${part.tool} failed`, time: { start: startedAt, end: created } }
          : {
              status: "completed",
              input,
              output: text,
              title: toolTitle(part.tool, input),
              metadata: {},
              time: { start: startedAt, end: created },
            };
      continue;
    }
    // system / custom entries are not rendered
  }
  return out;
}

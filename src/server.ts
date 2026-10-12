/**
 * HTTP + SSE server exposing the OpenCode API subset (M1) backed by pi.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { SessionManager } from "./sessions.js";
import { ApprovalInputError, toV2Permission } from "./approvals.js";
import { getAgentName, getExposedAgentNames } from "./agent-name.js";
import { loadCatalog, type Catalog } from "./catalog.js";
import {
  defaultV2Model,
  flattenModels,
  toV2Message,
  toV2Session,
  V2EventTranslator,
  type V2Session,
} from "./v2.js";
import type { OCEvent, OCModelRef, OCPromptBody, OCSession } from "./types.js";

const DEBUG_LOG = process.env.OCPI_DEBUG_LOG ?? "/tmp/openchamber-pi-debug.log";

// This connector is not opencode — it only implements an OpenCode API subset.
// OpenChamber reads /global/health's `version` as the installed opencode version
// and offers an update when it trails the latest release. Advertising the SDK
// contract version (1.18.31) made every adapter profile look permanently
// outdated, and the resulting "update" then failed with "Unknown installation
// method". Report no version so upgrade-status returns available:null and the UI
// shows no prompt. Set OCPI_OPENCODE_COMPAT_VERSION to advertise one on purpose.
const OPENCODE_COMPAT_VERSION = process.env.OCPI_OPENCODE_COMPAT_VERSION?.trim() || null;

/**
 * `archived` list filter per SDK v2 (`boolean | "true" | "false"`):
 * "true" keeps only archived sessions, "false" only live ones, absent = all.
 */
function applyArchivedFilter(sessions: OCSession[], archived: string | null) {
  if (archived === "true") return sessions.filter((s) => s.time.archived !== undefined);
  if (archived === "false") return sessions.filter((s) => s.time.archived === undefined);
  return sessions;
}

function debugLog(line: string): void {
  if (process.env.OCPI_DEBUG) appendFileSync(DEBUG_LOG, line + "\n");
}

function numberParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** v2 prompt bodies carry `model:{providerID, id|modelID}`; adapt to OCModelRef. */
function modelRefFromBody(model: { providerID?: string; id?: string; modelID?: string } | undefined): OCModelRef | undefined {
  if (!model || typeof model.providerID !== "string") return undefined;
  const modelID = typeof model.id === "string" ? model.id : typeof model.modelID === "string" ? model.modelID : undefined;
  if (modelID === undefined) return undefined;
  return { providerID: model.providerID, modelID };
}

export interface AdapterServerOptions {
  port: number;
  host: string;
  /** Fallback directory when requests carry no ?directory= param. */
  defaultDirectory: string;
}

export class AdapterServer {
  private server: Server;
  private sessions: SessionManager;
  /** SSE subscribers tagged by protocol flavor: v1 (`/event`) or v2 (`/api/event`). */
  private sseClients = new Map<ServerResponse, "v1" | "v2">();
  private v2events = new V2EventTranslator();
  private catalogPromise: Promise<Catalog> | undefined;
  private actualPort: number | undefined;

  constructor(private options: AdapterServerOptions) {
    this.sessions = new SessionManager((directory, event) => this.broadcast(directory, event), undefined, options.defaultDirectory);
    this.server = createServer((req, res) => void this.route(req, res));
  }

  private catalog(): Promise<Catalog> {
    this.catalogPromise ??= loadCatalog(this.options.defaultDirectory).catch((err) => {
      console.error("[catalog] failed to load models from pi:", err);
      return { providers: [], defaults: {} };
    });
    return this.catalogPromise;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => resolve());
    });
    const addr = this.server.address();
    this.actualPort = typeof addr === "object" && addr !== null ? addr.port : this.options.port;
  }

  get url(): string {
    const port = this.actualPort ?? this.options.port;
    return `http://${this.options.host}:${port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.sseClients.keys()) res.end();
    await this.sessions.disposeAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------
  // SSE
  // ---------------------------------------------------------------

  private broadcast(_directory: string, event: OCEvent): void {
    const v1Frame = `data: ${JSON.stringify(event)}\n\n`;
    const v2Frames = this.v2events.translate(_directory, event).map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
    for (const [res, flavor] of this.sseClients) {
      if (flavor === "v2") {
        for (const frame of v2Frames) res.write(frame);
      } else {
        res.write(v1Frame);
      }
    }
  }

  private handleSSE(res: ServerResponse, flavor: "v1" | "v2"): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    this.sseClients.set(res, flavor);
    // OpenChamber's SSE proxy aborts an upstream that is silent for 20s, so
    // mirror real opencode's `: heartbeat` comment keepalive.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": heartbeat\n\n");
    }, 10_000);
    heartbeat.unref?.();
    res.on("close", () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
    });
    // OpenCode emits server.connected on subscribe; OpenChamber waits for it.
    const connected =
      flavor === "v2"
        ? { id: `evt_${Date.now()}`, created: Date.now(), type: "server.connected", location: { directory: this.options.defaultDirectory }, data: {} }
        : { type: "server.connected", properties: {} };
    res.write(`data: ${JSON.stringify(connected)}\n\n`);
  }

  // ---------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    debugLog(`[http] ${req.method} ${req.url}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-opencode-directory");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    try {
      await this.handle(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.json(res, err instanceof ApprovalInputError ? 400 : 500, { name: err instanceof ApprovalInputError ? "InvalidRequestError" : "UnknownError", data: { message } });
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const directory =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      url.searchParams.get("location") ??
      req.headers["x-opencode-directory"] as string | undefined ??
      this.options.defaultDirectory;

    // SSE stream (v2 clients subscribe at /api/event; v1 at /event)
    if (method === "GET" && (path === "/event" || path === "/global/event")) {
      this.handleSSE(res, "v1");
      return;
    }
    if (method === "GET" && path === "/api/event") {
      this.handleSSE(res, "v2");
      return;
    }

    // --- opencode v2 API surface (OpenChamber 2.0.4 web UI) ---
    if (path === "/api" || path.startsWith("/api/")) {
      await this.handleV2(req, res, url, path, method, directory);
      return;
    }

    if (method === "GET" && path === "/global/health") {
      this.json(res, 200, OPENCODE_COMPAT_VERSION === null
        ? { healthy: true }
        : { healthy: true, version: OPENCODE_COMPAT_VERSION });
      return;
    }

    // There is no opencode install behind this endpoint to upgrade: the adapter
    // speaks the OpenCode API itself. Answer instead of 404 so a direct upgrade
    // call gets a clear reason rather than a bare HTTP status.
    if ((method === "POST" || method === "GET") && path === "/global/upgrade") {
      this.json(res, 409, {
        success: false,
        error: "This endpoint is served by the pi adapter (openchamber-pi-connector), not a real opencode install — there is nothing to upgrade.",
      });
      return;
    }

    // --- sessions ---
    if (path === "/session" && method === "POST") {
      const body = (await this.body(req)) as { parentID?: string; title?: string };
      this.json(res, 200, await this.sessions.create(directory, body.title, body.parentID));
      return;
    }
    if (path === "/session" && method === "GET") {
      const dir = url.searchParams.get("directory") ?? undefined;
      let sessions = this.sessions.list(dir);
      sessions = applyArchivedFilter(sessions, url.searchParams.get("archived"));
      this.json(res, 200, sessions);
      return;
    }
    if (path === "/session/status" && method === "GET") {
      this.json(res, 200, this.sessions.statuses());
      return;
    }

    const sessionMatch = path.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (sessionMatch) {
      const [, sessionId, sub] = sessionMatch;
      if (!this.sessions.get(sessionId!)) {
        this.json(res, 404, { name: "NotFoundError", data: { message: `session not found: ${sessionId}` } });
        return;
      }
      switch (`${method} ${sub ?? ""}`) {
        case "GET ":
          this.json(res, 200, this.sessions.get(sessionId!)!.info);
          return;
        case "PATCH ": {
          const body = (await this.body(req)) as { title?: string; time?: { archived?: number } };
          this.json(res, 200, this.sessions.update(sessionId!, { title: body.title, archived: body.time?.archived }));
          return;
        }
        case "DELETE ":
          this.json(res, 200, await this.sessions.remove(sessionId!));
          return;
        case "GET /message":
          this.json(res, 200, this.sessions.messages(sessionId!));
          return;
        case "POST /prompt_async": {
          const body = (await this.body(req)) as OCPromptBody;
          const text = (body.parts ?? [])
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text!)
            .join("\n");
          void this.sessions.prompt(sessionId!, text, body.model, body.noReply, body.messageID).catch(() => undefined);
          res.writeHead(204).end();
          return;
        }
        case "POST /message": {
          const body = (await this.body(req)) as OCPromptBody;
          const text = (body.parts ?? [])
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text!)
            .join("\n");
          await this.sessions.prompt(sessionId!, text, body.model, body.noReply, body.messageID);
          const msgs = this.sessions.messages(sessionId!) ?? [];
          this.json(res, 200, msgs[msgs.length - 1] ?? null);
          return;
        }
        case "POST /abort":
          this.json(res, 200, await this.sessions.abort(sessionId!));
          return;
        default:
          this.json(res, 501, { name: "NotImplemented", data: { message: `${method} ${path} not implemented (M1)` } });
          return;
      }
    }

    // --- project / config ---
    if (path === "/project/current" && method === "GET") {
      this.json(res, 200, { id: directory, worktree: directory, time: { created: Date.now() } });
      return;
    }
    if (path === "/project" && method === "GET") {
      this.json(res, 200, [{ id: directory, worktree: directory, time: { created: Date.now() } }]);
      return;
    }
    if ((path === "/config" || path === "/global/config") && method === "GET") {
      this.json(res, 200, {});
      return;
    }

    // --- model catalog (from pi) ---
    if (path === "/provider" && method === "GET") {
      const cat = await this.catalog();
      this.json(res, 200, { all: cat.providers, default: cat.defaults, connected: cat.providers.map((p) => p.id) });
      return;
    }
    if (path === "/config/providers" && method === "GET") {
      const cat = await this.catalog();
      this.json(res, 200, { providers: cat.providers, default: cat.defaults });
      return;
    }

    // --- bootstrap probes OpenChamber expects to exist ---
    if (path === "/experimental/session" && method === "GET") {
      // OpenChamber page-loads the sidebar through this route (not /session) with
      // ?directory=…&archived=…&roots=…&limit=…. Honor directory/roots/archived:
      // ignoring them left the sidebar with only live sessions, so restored
      // history never appeared after a restart; ignoring `archived` broke the
      // archive tab (it must show only time.archived sessions, while the normal
      // sidebar's archived=false must exclude them).
      const directoryParam =
        url.searchParams.get("directory") ?? (req.headers["x-opencode-directory"] as string | undefined);
      const rootsOnly = url.searchParams.get("roots") === "true";
      let sessions =
        directoryParam !== undefined && directoryParam !== ""
          ? this.sessions.list(directoryParam)
          : this.sessions.listAll();
      if (rootsOnly) sessions = sessions.filter((s) => s.parentID === undefined);
      sessions = applyArchivedFilter(sessions, url.searchParams.get("archived"));
      this.json(res, 200, sessions);
      return;
    }
    if (path === "/question" && method === "GET") {
      this.json(res, 200, this.sessions.questions());
      return;
    }
    if (path === "/permission" && method === "GET") {
      this.json(res, 200, this.sessions.permissions());
      return;
    }
    const questionReply = path.match(/^\/question\/([^/]+)\/reply$/);
    if (questionReply && method === "POST") {
      const requestID = decodeURIComponent(questionReply[1]!);
      const body = (await this.body(req)) as { answers?: Array<string[]> };
      const pending = this.sessions.questions().find((question) => question.id === requestID);
      if (!pending || !this.sessions.replyQuestion(pending.sessionID, requestID, body.answers ?? [])) {
        this.json(res, 404, { name: "QuestionNotFoundError", data: { message: `question not found: ${requestID}` } });
        return;
      }
      this.json(res, 200, true);
      return;
    }
    const questionReject = path.match(/^\/question\/([^/]+)\/reject$/);
    if (questionReject && method === "POST") {
      const requestID = decodeURIComponent(questionReject[1]!);
      const pending = this.sessions.questions().find((question) => question.id === requestID);
      if (!pending || !this.sessions.rejectQuestion(pending.sessionID, requestID)) {
        this.json(res, 404, { name: "QuestionNotFoundError", data: { message: `question not found: ${requestID}` } });
        return;
      }
      this.json(res, 200, true);
      return;
    }
    const permissionReply = path.match(/^\/permission\/([^/]+)\/reply$/);
    if (permissionReply && method === "POST") {
      const requestID = decodeURIComponent(permissionReply[1]!);
      const body = (await this.body(req)) as { reply?: "once" | "always" | "reject"; message?: string };
      const pending = this.sessions.permissions().find((permission) => permission.id === requestID);
      if (!pending || !body.reply || !this.sessions.replyPermission(pending.sessionID, requestID, body.reply, body.message)) {
        this.json(res, 404, { name: "PermissionNotFoundError", data: { message: `permission not found: ${requestID}` } });
        return;
      }
      this.json(res, 200, true);
      return;
    }
    if (path === "/lsp" && method === "GET") {
      this.json(res, 200, []);
      return;
    }
    if (path === "/formatter" && method === "GET") {
      this.json(res, 200, []);
      return;
    }
    if (path === "/mcp" && method === "GET") {
      this.json(res, 200, {});
      return;
    }
    if (path === "/command" && method === "GET") {
      this.json(res, 200, []);
      return;
    }
    if (path === "/path" && method === "GET") {
      this.json(res, 200, { home: homedir(), state: "", config: "", worktree: directory, directory });
      return;
    }
    if (path === "/vcs" && method === "GET") {
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory, timeout: 3000 }, (err, stdout) => {
        const branch = err ? undefined : stdout.trim() || undefined;
        this.json(res, 200, branch === undefined ? {} : { branch });
      });
      return;
    }
    if (path === "/agent" && method === "GET") {
      // pi has one agent; publish OpenChamber's conventional `build` primary
      // agent next to pi's own name so the picker — and its default resolution,
      // which looks for `build` — has a real option. Both names run the same
      // pi agent (see getExposedAgentNames).
      const piName = getAgentName();
      this.json(res, 200, getExposedAgentNames().map((name) => ({
        name,
        description:
          name === piName
            ? `${piName} (pi coding agent via openchamber-pi-connector)`
            : `${name} — ${piName} (pi coding agent via openchamber-pi-connector)`,
        mode: "primary",
        hidden: false,
        options: {},
      })));
      return;
    }

    this.json(res, 404, { name: "NotFoundError", data: { message: `no route: ${method} ${path}` } });
  }

  // ---------------------------------------------------------------
  // opencode v2 API surface (OpenChamber 2.0.4 web UI)
  // ---------------------------------------------------------------

  private v2Agents(): Array<{ id: string; name: string; description: string; mode: string; hidden: boolean; options: Record<string, unknown> }> {
    const piName = getAgentName();
    return getExposedAgentNames().map((name) => ({
      id: name,
      name,
      description:
        name === piName
          ? `${piName} (pi coding agent via openchamber-pi-connector)`
          : `${name} — ${piName} (pi coding agent via openchamber-pi-connector)`,
      mode: "primary",
      hidden: false,
      options: {},
    }));
  }

  private v2Session(info: OCSession): V2Session {
    const managed = this.sessions.get(info.id);
    return toV2Session(info, { model: managed?.model, agent: getAgentName() });
  }

  /** v2 `/api/project` list: the adapter has no project registry, so expose the
   * directories it knows about (the default plus every restorable session). */
  private v2Projects(): Array<Record<string, unknown>> {
    const dirs = new Set<string>([this.options.defaultDirectory]);
    for (const s of this.sessions.listAll()) dirs.add(s.directory);
    const now = Date.now();
    return [...dirs].map((dir) => ({
      id: dir,
      canonical: dir,
      time: { created: now, updated: now },
      sandboxes: [],
    }));
  }

  private async handleV2(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
    method: string,
    directory: string,
  ): Promise<void> {
    const location = { directory };
    const withLocation = (data: unknown) => ({ location, data });

    // --- bootstrap ---
    if (path === "/api/info" && method === "GET") {
      this.json(res, 200, {
        version: OPENCODE_COMPAT_VERSION ?? "2.0.18",
        pid: process.pid,
        urls: [this.url],
        paths: { tmp: tmpdir() },
      });
      return;
    }
    if (path === "/api/location" && method === "GET") {
      this.json(res, 200, { directory, project: { id: directory, directory, canonical: directory } });
      return;
    }
    if (path === "/api/config" && method === "GET") {
      this.json(res, 200, []);
      return;
    }
    if (path === "/api/provider" && method === "GET") {
      const cat = await this.catalog();
      this.json(res, 200, withLocation(cat.providers.map((p) => ({ ...p, activation: "enabled" }))));
      return;
    }
    if (path === "/api/model" && method === "GET") {
      const cat = await this.catalog();
      this.json(res, 200, withLocation(flattenModels(cat)));
      return;
    }
    if (path === "/api/model/default" && method === "GET") {
      const cat = await this.catalog();
      this.json(res, 200, withLocation(defaultV2Model(cat) ?? null));
      return;
    }
    if (path === "/api/agent" && method === "GET") {
      this.json(res, 200, withLocation(this.v2Agents()));
      return;
    }
    const agentMatch = path.match(/^\/api\/agent\/([^/]+)$/);
    if (agentMatch && method === "GET") {
      const agentId = decodeURIComponent(agentMatch[1]!);
      const agent = this.v2Agents().find((a) => a.id === agentId);
      if (!agent) {
        this.json(res, 404, { name: "NotFoundError", data: { message: `agent not found: ${agentId}` } });
        return;
      }
      this.json(res, 200, withLocation(agent));
      return;
    }
    if (path === "/api/command" && method === "GET") {
      this.json(res, 200, withLocation([]));
      return;
    }
    if (path === "/api/skill" && method === "GET") {
      this.json(res, 200, withLocation([]));
      return;
    }

    // --- project / vcs / permission / form (2.0.4 bootstrap) ---
    if (path === "/api/project" && method === "GET") {
      this.json(res, 200, this.v2Projects());
      return;
    }
    const projectMatch = path.match(/^\/api\/project\/([^/]+)$/);
    if (projectMatch && method === "PATCH") {
      const projectId = decodeURIComponent(projectMatch[1]!);
      const body = (await this.body(req)) as { canonical?: string };
      this.json(res, 200, {
        id: projectId,
        canonical: body.canonical ?? projectId,
        time: { created: 0, updated: Date.now() },
        sandboxes: [],
      });
      return;
    }
    if (path === "/api/permission/request" && method === "GET") {
      this.json(res, 200, withLocation(this.sessions.permissions().map(toV2Permission)));
      return;
    }
    if (path === "/api/question/request" && method === "GET") {
      this.json(res, 200, withLocation(this.sessions.questions()));
      return;
    }
    if (path === "/api/permission/saved" && method === "GET") {
      this.json(res, 200, { data: [] });
      return;
    }
    if (path.match(/^\/api\/permission\/saved\/[^/]+$/) && method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    if (path === "/api/form" && method === "GET") {
      this.json(res, 200, withLocation([]));
      return;
    }
    if (path === "/api/vcs" && method === "GET") {
      this.json(res, 200, withLocation({ branch: {} }));
      return;
    }
    if (path === "/api/vcs/base" && method === "GET") {
      this.json(res, 200, withLocation(null));
      return;
    }
    if (path === "/api/vcs/status" && method === "GET") {
      this.json(res, 200, withLocation([]));
      return;
    }
    if (path === "/api/vcs/branch" && method === "GET") {
      this.json(res, 200, withLocation([]));
      return;
    }
    if (path === "/api/vcs/diff" && method === "GET") {
      this.json(res, 200, withLocation(""));
      return;
    }

    // --- sessions ---
    if (path === "/api/session" && method === "GET") {
      const dir = url.searchParams.get("directory") ?? url.searchParams.get("location");
      const search = url.searchParams.get("search");
      const limit = numberParam(url.searchParams.get("limit"));
      let infos = dir !== null && dir !== "" ? this.sessions.list(dir) : this.sessions.listAll();
      if (search) infos = infos.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()));
      const sessions = infos.map((info) => this.v2Session(info));
      sessions.sort((a, b) => b.time.updated - a.time.updated);
      const page = limit !== undefined ? sessions.slice(0, limit) : sessions;
      // The 2.0.4 UI reads `cursor.previous` unconditionally — a list body
      // without a cursor throws "Cannot read properties of undefined".
      this.json(res, 200, { data: page, cursor: { previous: null, next: null } });
      return;
    }
    if (path === "/api/session" && method === "POST") {
      const body = (await this.body(req)) as {
        title?: string;
        parentID?: string;
        location?: { directory?: string };
      };
      const dir = body.location?.directory ?? directory;
      const info = await this.sessions.create(dir, body.title, body.parentID);
      this.json(res, 200, { data: this.v2Session(info) });
      return;
    }
    if (path === "/api/session/active" && method === "GET") {
      const data: Record<string, { type: "running" }> = {};
      for (const [id, status] of Object.entries(this.sessions.statuses())) {
        if (status.type !== "idle") data[id] = { type: "running" };
      }
      this.json(res, 200, { data });
      return;
    }

    const sessionMatch = path.match(/^\/api\/session\/([^/]+)(\/.+)?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const sub = sessionMatch[2] ?? "";
      const managed = this.sessions.get(sessionId);
      if (!managed) {
        this.json(res, 404, { name: "NotFoundError", data: { message: `session not found: ${sessionId}` } });
        return;
      }

      const messageMatch = sub.match(/^\/message\/([^/]+)$/);
      if (messageMatch && method === "GET") {
        const messageId = decodeURIComponent(messageMatch[1]!);
        const found = (this.sessions.messages(sessionId) ?? []).find((m) => m.info.id === messageId);
        if (!found) {
          this.json(res, 404, { name: "MessageNotFoundError", data: { message: `message not found: ${messageId}` } });
          return;
        }
        this.json(res, 200, { data: toV2Message(found) });
        return;
      }

      // Forms/permissions have no adapter-side store; answer the lifecycle routes
      // the 2.0.4 UI polls rather than 404ing the whole panel.
      const formMatch = sub.match(/^\/form\/([^/]+)(\/reply)?$/);
      if (formMatch) {
        const formId = decodeURIComponent(formMatch[1]!);
        if (formMatch[2] === "/reply" && method === "POST") {
          await this.body(req);
          res.writeHead(204).end();
          return;
        }
        if (method === "DELETE") {
          res.writeHead(204).end();
          return;
        }
        if (method === "GET") {
          this.json(res, 404, { name: "FormNotFoundError", data: { message: `form not found: ${formId}` } });
          return;
        }
      }
      const questionMatch = sub.match(/^\/question\/([^/]+)(\/reply|\/reject)?$/);
      if (questionMatch) {
        const requestId = decodeURIComponent(questionMatch[1]!);
        if (questionMatch[2] === "/reply" && method === "POST") {
          const body = (await this.body(req)) as { answers?: Array<string[]> };
          if (!this.sessions.replyQuestion(sessionId, requestId, body.answers ?? [])) {
            this.json(res, 404, { name: "QuestionNotFoundError", data: { message: `question not found: ${requestId}` } });
            return;
          }
          res.writeHead(204).end();
          return;
        }
        if (questionMatch[2] === "/reject" && method === "POST") {
          if (!this.sessions.rejectQuestion(sessionId, requestId)) {
            this.json(res, 404, { name: "QuestionNotFoundError", data: { message: `question not found: ${requestId}` } });
            return;
          }
          res.writeHead(204).end();
          return;
        }
        if (method === "GET") {
          const question = this.sessions.questions(sessionId).find((entry) => entry.id === requestId);
          if (question === undefined) this.json(res, 404, { name: "QuestionNotFoundError", data: { message: `question not found: ${requestId}` } });
          else this.json(res, 200, { data: question });
          return;
        }
      }
      const permissionMatch = sub.match(/^\/permission\/([^/]+)(\/reply)?$/);
      if (permissionMatch) {
        const requestId = decodeURIComponent(permissionMatch[1]!);
        if (permissionMatch[2] === "/reply" && method === "POST") {
          const body = (await this.body(req)) as { reply?: "once" | "always" | "reject"; message?: string };
          if (!body.reply || !this.sessions.replyPermission(sessionId, requestId, body.reply, body.message)) {
            this.json(res, 404, { name: "PermissionNotFoundError", data: { message: `permission not found: ${requestId}` } });
            return;
          }
          res.writeHead(204).end();
          return;
        }
        if (method === "GET") {
          const permission = this.sessions.permissions(sessionId).find((entry) => entry.id === requestId);
          if (permission === undefined) this.json(res, 404, { name: "PermissionNotFoundError", data: { message: `permission not found: ${requestId}` } });
          else this.json(res, 200, { data: toV2Permission(permission) });
          return;
        }
      }

      switch (`${method} ${sub}`) {
        case "GET ": {
          this.json(res, 200, { data: this.v2Session(managed.info) });
          return;
        }
        case "PATCH ": {
          const body = (await this.body(req)) as { title?: string; time?: { archived?: number } };
          this.sessions.update(sessionId, { title: body.title, archived: body.time?.archived });
          res.writeHead(204).end();
          return;
        }
        case "DELETE ": {
          await this.sessions.remove(sessionId);
          res.writeHead(204).end();
          return;
        }
        case "GET /message": {
          const order = url.searchParams.get("order");
          const limit = numberParam(url.searchParams.get("limit"));
          let messages = (this.sessions.messages(sessionId) ?? []).map((m) => toV2Message(m));
          if (order !== "asc") messages = messages.reverse(); // v2 default is newest-first
          if (limit !== undefined) messages = messages.slice(0, limit);
          this.json(res, 200, { data: messages, cursor: { previous: null, next: null } });
          return;
        }
        case "POST /prompt": {
          const body = (await this.body(req)) as {
            id?: string;
            text?: string;
            model?: { providerID?: string; id?: string; modelID?: string };
            delivery?: string;
          };
          const text = typeof body.text === "string" ? body.text : "";
          const messageID = typeof body.id === "string" && body.id !== "" ? body.id : `msg_${randomUUID().replaceAll("-", "")}`;
          const model = modelRefFromBody(body.model);
          void this.sessions.prompt(sessionId, text, model, false, messageID).catch((err) => {
            console.error(`[prompt] session ${sessionId} failed:`, err);
          });
          const delivery = typeof body.delivery === "string" ? body.delivery : "steer";
          this.json(res, 200, {
            data: {
              id: messageID,
              sessionID: sessionId,
              time: { created: Date.now() },
              type: "user",
              text,
              payload: { text },
              delivery,
            },
          });
          return;
        }
        case "POST /interrupt": {
          await this.sessions.abort(sessionId);
          this.json(res, 200, { data: true });
          return;
        }
        case "POST /agent": {
          await this.body(req); // agent is fixed per connector — acknowledge and ignore
          res.writeHead(204).end();
          return;
        }
        case "POST /model": {
          // The UI awaits this before every prompt (applySendSelection →
          // switchModel), so it is the only route from the bottom-right picker
          // to pi. Dropping the body used to leave the UI showing a model pi
          // never ran. 204 empty is the contract; 400/404 are the statuses the
          // client declares, and a loud failure beats a silent drift.
          const body = (await this.body(req)) as { model?: { providerID?: string; id?: string; modelID?: string } };
          const ref = modelRefFromBody(body.model);
          if (ref === undefined) {
            this.json(res, 400, { error: "model is required: {providerID, modelID}" });
            return;
          }
          try {
            const resolved = await this.sessions.setModel(sessionId, ref);
            if (resolved.modelID !== ref.modelID || resolved.providerID !== ref.providerID) {
              // pi resolved the request to a different concrete model (alias or
              // provider-reported id). Not an error, but the reason the UI ends
              // up showing something other than what was picked.
              debugLog(`[model] session ${sessionId}: pi resolved ${ref.providerID}/${ref.modelID} -> ${resolved.providerID}/${resolved.modelID}`);
            }
            res.writeHead(204).end();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[model] session ${sessionId} → ${ref.providerID}/${ref.modelID} failed:`, message);
            this.json(res, message.startsWith("unknown session:") ? 404 : 400, { error: message });
          }
          return;
        }
        case "GET /form": {
          this.json(res, 200, { data: [] });
          return;
        }
        case "GET /question": {
          this.json(res, 200, { data: this.sessions.questions(sessionId) });
          return;
        }
        case "GET /permission": {
          this.json(res, 200, { data: this.sessions.permissions(sessionId).map(toV2Permission) });
          return;
        }
        case "GET /inbox": {
          this.json(res, 200, { data: [] });
          return;
        }
        case "GET /diff":
        case "GET /context": {
          this.json(res, 501, { name: "NotImplemented", data: { message: `${method} ${path} is not implemented by this connector` } });
          return;
        }
        default:
          this.json(res, 501, { name: "NotImplemented", data: { message: `${method} ${path} not implemented` } });
          return;
      }
    }

    this.json(res, 404, { name: "NotFoundError", data: { message: `no route: ${method} ${path}` } });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" }).end(payload);
  }

  private body(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      req.on("error", reject);
    });
  }
}

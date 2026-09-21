/**
 * HTTP + SSE server exposing the OpenCode API subset (M1) backed by pi.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { SessionManager } from "./sessions.js";
import { loadCatalog, type Catalog } from "./catalog.js";
import type { OCEvent, OCPromptBody } from "./types.js";

const DEBUG_LOG = process.env.OCPI_DEBUG_LOG ?? "/tmp/openchamber-pi-debug.log";

// OpenChamber reads /global/health's version as the opencode version and nags about updates.
const OPENCODE_COMPAT_VERSION = "1.18.31";

function debugLog(line: string): void {
  if (process.env.OCPI_DEBUG) appendFileSync(DEBUG_LOG, line + "\n");
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
  private sseClients = new Set<ServerResponse>();
  private catalogPromise: Promise<Catalog> | undefined;
  private actualPort: number | undefined;

  constructor(private options: AdapterServerOptions) {
    this.sessions = new SessionManager((directory, event) => this.broadcast(directory, event));
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
    for (const res of this.sseClients) res.end();
    await this.sessions.disposeAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------
  // SSE
  // ---------------------------------------------------------------

  private broadcast(_directory: string, event: OCEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseClients) res.write(frame);
  }

  private handleSSE(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
    // OpenCode emits server.connected on subscribe; OpenChamber waits for it.
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
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
      this.json(res, 500, { name: "UnknownError", data: { message } });
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const directory =
      url.searchParams.get("directory") ??
      req.headers["x-opencode-directory"] as string | undefined ??
      this.options.defaultDirectory;

    // SSE stream
    if (method === "GET" && (path === "/event" || path === "/global/event")) {
      this.handleSSE(res);
      return;
    }

    if (method === "GET" && path === "/global/health") {
      this.json(res, 200, { healthy: true, version: OPENCODE_COMPAT_VERSION });
      return;
    }

    // --- sessions ---
    if (path === "/session" && method === "POST") {
      const body = (await this.body(req)) as { parentID?: string; title?: string };
      this.json(res, 200, await this.sessions.create(directory, body.title, body.parentID));
      return;
    }
    if (path === "/session" && method === "GET") {
      this.json(res, 200, this.sessions.list(url.searchParams.get("directory") ?? undefined));
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
          const body = (await this.body(req)) as { title?: string };
          this.json(res, 200, this.sessions.rename(sessionId!, body.title ?? ""));
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
      this.json(res, 200, this.sessions.list());
      return;
    }
    if (path === "/question" && method === "GET") {
      this.json(res, 200, []);
      return;
    }
    if (path === "/permission" && method === "GET") {
      this.json(res, 200, []);
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
      this.json(res, 200, [
        { name: "build", description: "pi coding agent (via openchamber-pi-connector)", mode: "primary", hidden: false, options: {} },
      ]);
      return;
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

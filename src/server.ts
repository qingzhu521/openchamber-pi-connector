/**
 * HTTP + SSE server exposing the OpenCode API subset (M1) backed by pi.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { SessionManager } from "./sessions.js";
import type { OCEvent, OCPromptBody } from "./types.js";

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

  constructor(private options: AdapterServerOptions) {
    this.sessions = new SessionManager((directory, event) => this.broadcast(directory, event));
    this.server = createServer((req, res) => void this.route(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => resolve());
    });
  }

  get url(): string {
    return `http://${this.options.host}:${this.options.port}`;
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
      this.json(res, 200, { healthy: true, version: "0.1.0" });
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
          void this.sessions.prompt(sessionId!, text);
          res.writeHead(204).end();
          return;
        }
        case "POST /message": {
          const body = (await this.body(req)) as OCPromptBody;
          const text = (body.parts ?? [])
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text!)
            .join("\n");
          await this.sessions.prompt(sessionId!, text);
          // Synchronous variant: return current transcript tail.
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
    if (path === "/config" && method === "GET") {
      this.json(res, 200, {});
      return;
    }
    if (path === "/provider" && method === "GET") {
      // M1: empty provider list; model display comes from message metadata.
      this.json(res, 200, { all: [], default: {}, connected: [] });
      return;
    }
    if (path === "/config/providers" && method === "GET") {
      this.json(res, 200, { providers: [], default: {} });
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

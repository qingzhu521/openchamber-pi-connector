/**
 * pi RPC subprocess client.
 *
 * Speaks pi's headless JSONL protocol (`pi --mode rpc`): commands go to stdin,
 * responses and events come back on stdout. Framing is strict LF-only JSONL —
 * pi's docs warn that generic line readers (Node `readline`) also split on
 * U+2028/U+2029, which are legal inside JSON strings, so we split on "\n"
 * ourselves and only strip a single trailing "\r".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface PiRpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface PiRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface PiRpcClientOptions {
  cwd: string;
  /** Path/name of the pi binary. Defaults to "pi" from PATH. */
  piBinary?: string;
  /** Extra CLI flags, e.g. ["--no-session"] or ["--provider", "x"]. */
  args?: string[];
}

interface PendingRequest {
  resolve: (r: PiRpcResponse) => void;
  reject: (e: Error) => void;
}

export class PiRpcClient extends EventEmitter {
  private proc: ChildProcess;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private pending = new Map<string, PendingRequest>();
  private closed = false;

  onEvent(listener: (payload: Record<string, unknown>) => void): this {
    return super.on("event", listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): this {
    return super.on("exit", listener);
  }

  constructor(private options: PiRpcClientOptions) {
    super();
    const args = ["--mode", "rpc", ...(options.args ?? [])];
    this.proc = spawn(options.piBinary ?? "pi", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });

    this.proc.stdout!.on("data", (chunk: Buffer | string) => {
      this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      this.drain();
    });
    this.proc.stdout!.on("end", () => {
      this.buffer += this.decoder.end();
      this.drain();
      this.failAll(new Error("pi process closed stdout"));
    });
    this.proc.on("error", (err) => this.failAll(err));
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`pi exited (code=${code} signal=${signal})`));
      this.emit("exit", code, signal);
    });
  }

  private drain(): void {
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) return;
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON noise on stdout; ignore but keep going.
      return;
    }

    if (msg.type === "response") {
      const res = msg as unknown as PiRpcResponse;
      if (res.id !== undefined) {
        const p = this.pending.get(res.id);
        if (p) {
          this.pending.delete(res.id);
          p.resolve(res);
        }
      }
      return;
    }

    if (msg.type === "extension_ui_request") {
      this.handleExtensionUI(msg);
      return;
    }

    this.emit("event", msg);
  }

  /**
   * M1 policy for the extension-UI sub-protocol: fire-and-forget methods are
   * ignored; blocking dialogs (select/confirm/input/editor) are cancelled so
   * the agent never deadlocks waiting on a UI we do not render yet.
   */
  private handleExtensionUI(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;
    const id = msg.id as string | undefined;
    if (!id || !method) return;
    const blocking = new Set(["select", "confirm", "input", "editor"]);
    if (!blocking.has(method)) return;
    this.write({ type: "extension_ui_response", id, cancelled: true });
  }

  private write(obj: Record<string, unknown>): void {
    if (this.closed) return;
    this.proc.stdin!.write(JSON.stringify(obj) + "\n");
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Send a command and wait for its correlated response. */
  command<T = unknown>(cmd: Omit<PiRpcCommand, "id">, timeoutMs = 60_000): Promise<PiRpcResponse & { data?: T }> {
    if (this.closed) return Promise.reject(new Error("pi process is not running"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command "${cmd.type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r as PiRpcResponse & { data?: T });
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ ...cmd, id });
    });
  }

  /** Fire-and-forget command (no response correlation). */
  notify(cmd: Omit<PiRpcCommand, "id">): void {
    this.write(cmd);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin!.end();
    } catch {
      /* already closed */
    }
    // Give pi a moment to shut down on stdin EOF, then escalate.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          /* noop */
        }
        resolve();
      }, 2_000);
      this.proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

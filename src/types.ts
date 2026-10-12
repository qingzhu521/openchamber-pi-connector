/**
 * Minimal OpenCode server API types emitted by the adapter.
 * Shapes mirror @opencode-ai/sdk (v2) generated types — only the fields
 * OpenChamber reads for the M1 chat loop are populated.
 */

export interface OCModelRef {
  providerID: string;
  modelID: string;
}

export interface OCSession {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  time: {
    created: number;
    updated: number;
    compacting?: number;
    /** Epoch ms — presence marks the session archived (SDK v2 session.update). */
    archived?: number;
  };
}

export interface OCUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent: string;
  model: OCModelRef;
}

export interface OCAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  path: { cwd: string; root: string };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  finish?: string;
  error?: { name: string; data: { message: string } };
}

export type OCMessage = OCUserMessage | OCAssistantMessage;

export interface OCTextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  time?: { start: number; end?: number };
}

export interface OCReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  time?: { start: number; end?: number };
}

/**
 * Tool call part (M2). `state` mirrors @opencode-ai/sdk v2 (1.18.31)
 * `ToolState` exactly — a discriminated union on `.status` with
 * input/output/title living inside the state object (verified against the
 * locally installed dist/v2/gen/types.gen.d.ts).
 */
export interface OCToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface OCToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: { start: number };
}

export interface OCToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { start: number; end: number };
}

export interface OCToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end: number };
}

export type OCToolState = OCToolStatePending | OCToolStateRunning | OCToolStateCompleted | OCToolStateError;

export interface OCToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: OCToolState;
}

export type OCPart = OCTextPart | OCReasoningPart | OCToolPart;

export interface OCMessageWithParts {
  info: OCMessage;
  parts: OCPart[];
}

export type OCSessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number };

export type OCEvent =
  | { type: "server.connected"; properties: Record<string, unknown> }
  | { type: "session.created"; properties: { info: OCSession } }
  | { type: "session.updated"; properties: { info: OCSession } }
  | { type: "session.deleted"; properties: { info: OCSession } }
  | { type: "session.status"; properties: { sessionID: string; status: OCSessionStatus } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID?: string; error?: { name: string; data: { message: string } } } }
  | { type: "message.updated"; properties: { info: OCMessage } }
  | { type: "message.part.updated"; properties: { part: OCPart; delta?: string } }
  | {
      type: "permission.asked";
      properties: {
        id: string;
        sessionID: string;
        permission: string;
        patterns: string[];
        metadata: Record<string, unknown>;
        always: string[];
        tool?: { messageID: string; callID: string };
      };
    }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" } }
  | {
      type: "question.asked";
      properties: {
        id: string;
        sessionID: string;
        questions: Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiple?: boolean;
          custom?: boolean;
        }>;
        tool?: { messageID: string; callID: string };
      };
    }
  | { type: "question.replied"; properties: { sessionID: string; requestID: string; answers: Array<string[]> } }
  | { type: "question.rejected"; properties: { sessionID: string; requestID: string } }
  /**
   * The model pi is actually running changed — either the UI asked for it or pi
   * changed it on its own side. v2.ts maps this to `session.model.selected`,
   * the only channel OpenChamber has for learning the truth from the server;
   * its picker is otherwise client-local state that happily drifts.
   */
  | { type: "model.changed"; properties: { sessionID: string; model: OCModelRef; previous?: OCModelRef } };

export interface OCProject {
  id: string;
  worktree: string;
  vcs?: "git";
  time: { created: number; initialized?: number };
}

/** Incoming prompt body for POST /session/{id}/message and /prompt_async */
export interface OCPromptBody {
  messageID?: string;
  model?: OCModelRef;
  agent?: string;
  noReply?: boolean;
  system?: string;
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

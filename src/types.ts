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

export type OCPart = OCTextPart | OCReasoningPart;

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
  | { type: "message.part.updated"; properties: { part: OCPart; delta?: string } };

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

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanAllPiSessions, scanPiSessions } from "../src/session-store.js";

function withAgentDir(agentDir: string, run: () => void): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function sessionHeader(id: string, cwd: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-12T00:00:00.000Z",
    cwd,
  })}\n`;
}

function sessionDir(agentDir: string, cwd: string): string {
  const sanitized = cwd.replace(/^[/\\]+/, "").replace(/[\\/:\u0000]/g, "-");
  return join(agentDir, "sessions", `--${sanitized}--`);
}

test("scanAllPiSessions finds OmO sessions across cwd folders", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "ocpi-agent-"));
  const firstCwd = "/tmp/openchamber-first";
  const secondCwd = "/tmp/openchamber-second";
  try {
    withAgentDir(agentDir, () => {
      for (const [cwd, id] of [
        [firstCwd, "first-session"],
        [secondCwd, "second-session"],
      ] as const) {
        const dir = sessionDir(agentDir, cwd);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.jsonl`), sessionHeader(id, cwd));
      }

      const scanned = scanAllPiSessions();
      assert.deepEqual(
        new Map(scanned.map((session) => [session.piSessionId, session.directory])),
        new Map([
          ["first-session", firstCwd],
          ["second-session", secondCwd],
        ]),
      );
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("scanPiSessions skips a header whose cwd mismatches its folder", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "ocpi-agent-"));
  const expectedCwd = "/tmp/openchamber-expected";
  try {
    withAgentDir(agentDir, () => {
      const dir = sessionDir(agentDir, expectedCwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mismatch.jsonl"), sessionHeader("mismatch-session", "/tmp/other-cwd"));

      assert.deepEqual(scanPiSessions(expectedCwd), []);
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

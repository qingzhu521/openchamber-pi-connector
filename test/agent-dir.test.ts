import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { piAgentDir } from "../src/agent-dir.js";

function withAgentEnv(
  env: { PI_CODING_AGENT_DIR?: string; OMO_CODING_AGENT_DIR?: string },
  run: () => void,
): void {
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    OMO_CODING_AGENT_DIR: process.env.OMO_CODING_AGENT_DIR,
  };
  try {
    if (env.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
    if (env.OMO_CODING_AGENT_DIR === undefined) delete process.env.OMO_CODING_AGENT_DIR;
    else process.env.OMO_CODING_AGENT_DIR = env.OMO_CODING_AGENT_DIR;
    run();
  } finally {
    if (previous.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
    if (previous.OMO_CODING_AGENT_DIR === undefined) delete process.env.OMO_CODING_AGENT_DIR;
    else process.env.OMO_CODING_AGENT_DIR = previous.OMO_CODING_AGENT_DIR;
  }
}

test("piAgentDir prioritizes PI_CODING_AGENT_DIR over OMO_CODING_AGENT_DIR", () => {
  withAgentEnv(
    { PI_CODING_AGENT_DIR: "/tmp/pi-agent", OMO_CODING_AGENT_DIR: "/tmp/omo-agent" },
    () => assert.equal(piAgentDir(), "/tmp/pi-agent"),
  );
});

test("piAgentDir uses OMO_CODING_AGENT_DIR when PI_CODING_AGENT_DIR is empty", () => {
  withAgentEnv(
    { PI_CODING_AGENT_DIR: "", OMO_CODING_AGENT_DIR: "/tmp/omo-agent" },
    () => assert.equal(piAgentDir(), "/tmp/omo-agent"),
  );
});

test("piAgentDir expands a leading home-directory marker", () => {
  withAgentEnv({ PI_CODING_AGENT_DIR: "~/custom-agent" }, () => {
    assert.equal(piAgentDir(), join(homedir(), "custom-agent"));
  });
});

test("piAgentDir falls back to pi's default agent directory", () => {
  withAgentEnv({}, () => assert.equal(piAgentDir(), join(homedir(), ".pi", "agent")));
});

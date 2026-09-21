/**
 * Live protocol probe for pi's RPC mode — dumps every stdout event to
 * pi-probe-events.jsonl so tool-call event shapes can be verified before
 * the adapter maps them (same M0 discipline as the mcode repo).
 *
 *   npm run probe [-- <prompt>]
 */

import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { PiRpcClient } from "../src/pi-rpc.js";

const OUT = join(process.cwd(), "pi-probe-events.jsonl");
const out = openSync(OUT, "w");
let closed = false;
const write = (line: string): void => {
  if (closed) return;
  try {
    writeSync(out, line + "\n");
  } catch {
    /* fd already closed */
  }
};

const prompt =
  process.argv.slice(2).join(" ") ||
  "Use your bash tool to run exactly this command: echo pi-probe-ok. Then reply with just the stdout you saw.";

const pi = new PiRpcClient({ cwd: process.cwd() });

let finished = false;
const finish = (reason: string): void => {
  if (finished) return;
  finished = true;
  write(`\n# probe end: ${reason}\n`);
  closed = true;
  try {
    closeSync(out);
  } catch {
    /* already closed */
  }
  void pi.dispose().finally(() => process.exit(0));
};

pi.onEvent((ev) => {
  write(JSON.stringify(ev));
  if (ev.type === "agent_end") finish("agent_end");
});
pi.onExit((code, signal) => finish(`exit code=${code} signal=${signal}`));

const state = await pi.command({ type: "get_state" });
write(`# get_state -> ${JSON.stringify(state)}`);

const res = await pi.command({ type: "prompt", message: prompt }, 240_000);
write(`# prompt -> ${JSON.stringify(res).slice(0, 400)}`);

setTimeout(() => finish("timeout 240s"), 240_000).unref();

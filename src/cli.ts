#!/usr/bin/env node
/**
 * openchamber-pi-connector CLI.
 *
 * Default mode:
 *   openchamber-pi [--port 4096] [--host 127.0.0.1] [--directory /path]
 *
 * OpenCode-compatible serve mode — OpenChamber spawns
 * `$OPENCODE_BINARY serve --hostname H --port P` and waits for the stdout
 * line "opencode server listening on <url>", then health-checks
 * GET /global/health:
 *   openchamber-pi serve --hostname 127.0.0.1 --port 4096 [--directory /path]
 */

import { AdapterServer } from "./server.js";

function arg(name: string, fallback: string): string {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}` && argv[i + 1] !== undefined) return argv[i + 1]!;
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

const serveMode = process.argv[2] === "serve";

const port = Number(arg("port", "4096"));
const host = arg("host", arg("hostname", "127.0.0.1"));
const directory = arg("directory", process.cwd());

const server = new AdapterServer({ port, host, defaultDirectory: directory });

await server.start();

if (serveMode) {
  console.log(`opencode server listening on ${server.url}`);
} else {
  console.log(`openchamber-pi-connector listening on ${server.url}`);
  console.log(`default directory: ${directory}`);
}

const shutdown = (): void => {
  void server.stop().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

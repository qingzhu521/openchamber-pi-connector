#!/usr/bin/env node
/**
 * openchamber-pi-connector CLI entry.
 *
 *   openchamber-pi [--port 4096] [--host 127.0.0.1] [--directory /path/to/project]
 *
 * Then point OpenChamber at the printed URL as an external OpenCode server.
 */

import { AdapterServer } from "./server.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const port = Number(arg("port", "4096"));
const host = arg("host", "127.0.0.1");
const directory = arg("directory", process.cwd());

const server = new AdapterServer({ port, host, defaultDirectory: directory });

await server.start();
console.log(`openchamber-pi-connector listening on ${server.url}`);
console.log(`default directory: ${directory}`);
console.log("point OpenChamber at this URL as an external OpenCode server");

const shutdown = (): void => {
  void server.stop().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

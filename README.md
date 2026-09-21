# OpenChamber Pi Connector

Use [OpenChamber](https://github.com/openchamber/openchamber) with the
[pi coding agent](https://github.com/badlogic/pi-mono) (`@earendil-works/pi-coding-agent`)
instead of OpenCode.

`openchamber-pi` is a local adapter server that speaks the subset of the
OpenCode HTTP/SSE API that OpenChamber actually consumes, and drives pi agent
sessions underneath via pi's [RPC mode](https://pi.dev/docs/latest/rpc)
(`pi --mode rpc`, JSONL over stdio) or the pi SDK (`AgentSession`).

```
OpenChamber (UI)  ──OpenCode API──▶  openchamber-pi  ──JSONL/stdio──▶  pi --mode rpc (one process per session)
```

No OpenChamber fork required: point OpenChamber at this adapter as an
**external OpenCode server** and sessions run on pi.

[![GitHub stars](https://img.shields.io/github/stars/qingzhu521/openchamber-pi-connector?style=flat&labelColor=100F0F&color=66800B)](https://github.com/qingzhu521/openchamber-pi-connector/stargazers)
[![License](https://img.shields.io/github/license/qingzhu521/openchamber-pi-connector?style=flat&labelColor=100F0F&color=205EA6)](./LICENSE)
[![OpenChamber](https://img.shields.io/badge/OpenChamber-1.24.x-100F0F?style=flat)](https://github.com/openchamber/openchamber)

## Quick start

Needs Node.js 22+ and the `pi` CLI on PATH (`npm i -g @earendil-works/pi-coding-agent`).

```bash
git clone https://github.com/qingzhu521/openchamber-pi-connector.git
cd openchamber-pi-connector
npm install && npm run build

mkdir -p ~/.config/openchamber-pi
printf '{\n  "opencodeBinary": "%s/bin/opencode-pi"\n}\n' "$PWD" \
  > ~/.config/openchamber-pi/settings.json

OPENCHAMBER_DATA_DIR=~/.config/openchamber-pi openchamber serve --port 57124
# open http://127.0.0.1:57124
```

That starts a second OpenChamber instance whose sessions run on pi, leaving
your main OpenChamber setup untouched.

## Compatibility

| OpenChamber | Status |
|---|---|
| 1.24.x (desktop, API v1) | tested against 1.24.2 |
| other versions | not tested |

OpenChamber changes which OpenCode API calls it makes between releases. If a
feature breaks on a newer OpenChamber, run `npm run smoke` to see which part
failed, then open an issue with the output. See
[docs/api-surface.md](docs/api-surface.md) for the endpoints this adapter
implements.

## Status

**M1 + M2 work**: a real OpenChamber UI session chatting through the adapter
with pi as the backend — session create, prompt, live text/reasoning
streaming over SSE, **tool call parts** (bash/write/edit… rendered in
OpenChamber with arguments, results and completed/error states, mapped to
the SDK v2 `ToolState` union), abort, rename, delete, model catalog from pi.
See [docs/architecture.md](docs/architecture.md) for the design and
[docs/api-surface.md](docs/api-surface.md) for the endpoint compatibility
list.

## Usage with OpenChamber

OpenChamber spawns whatever `$OPENCODE_BINARY` / `settings.opencodeBinary`
points to as `serve --hostname H --port P`, waits for the stdout line
`opencode server listening on <url>`, then health-checks `/global/health`.
This repo's `bin/opencode-pi` wrapper implements that contract on top of pi.

Recommended: run a second, isolated OpenChamber profile so your main setup is
untouched:

```bash
# isolated profile dir
mkdir -p ~/.config/openchamber-pi
cat > ~/.config/openchamber-pi/settings.json <<'EOF'
{
  "opencodeBinary": "/absolute/path/to/openchamber-pi-connector/bin/opencode-pi"
}
EOF

# start OpenChamber with pi as the agent backend
OPENCHAMBER_DATA_DIR=~/.config/openchamber-pi openchamber serve --port 57124
# open http://127.0.0.1:57124
```

Requires: Node.js 22+, the `pi` CLI on PATH (`npm i -g @earendil-works/pi-coding-agent`).

Debug logging: set `OCPI_DEBUG=1` (writes HTTP requests and pi events to
`/tmp/openchamber-pi-debug.log`, override with `OCPI_DEBUG_LOG`).

## Standalone / smoke test

```bash
npm install
npm run build
npm run smoke   # end-to-end: bootstrap probes, tool round (real pi run), abort, rename, delete
npm run probe   # dump raw pi RPC events to pi-probe-events.jsonl (protocol forensics)
```

## Why

- OpenChamber is a great workspace UI (multi-run, session goals, diff
  walkthroughs, mobile surfaces) but is hard-wired to the OpenCode SDK.
- pi is a minimal, hackable coding agent with a first-class headless RPC
  protocol and SDK — but no rich UI.
- This project connects the two without forking either.

## Non-goals

- Reimplementing OpenChamber's own platform features (scheduler, relay,
  goals). Those live in OpenChamber and keep working.
- Wrapping pi as an LLM provider inside OpenCode. pi is a full agent with its
  own loop; we adapt at the session-protocol level.

## License

MIT

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

## Status

Early development. See [docs/architecture.md](docs/architecture.md) for the
design and [docs/api-surface.md](docs/api-surface.md) for the endpoint
compatibility list.

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

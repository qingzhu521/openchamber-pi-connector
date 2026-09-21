# Architecture

## Goal

OpenChamber talks to an OpenCode server over HTTP + SSE via
`@opencode-ai/sdk/v2`. The pi coding agent exposes headless operation via RPC
mode (`pi --mode rpc`, JSONL over stdin/stdout) and an in-process SDK
(`AgentSession` from `@earendil-works/pi-coding-agent`).

`openchamber-pi` bridges the two:

```
OpenChamber ──HTTP/SSE (OpenCode API subset)──▶ openchamber-pi ──JSONL stdio──▶ pi --mode rpc
```

OpenChamber is configured to use an **external OpenCode server** pointing at
this adapter. No OpenChamber fork, no pi fork.

## Two backend strategies

| Strategy | Mechanism | Pros | Cons |
|---|---|---|---|
| SDK embed | `AgentSession` in-process | No subprocess overhead, typed API | Ties adapter lifecycle to pi internals |
| RPC subprocess | spawn `pi --mode rpc` per session | Process isolation, version-tolerant, language-stable protocol | One process per session, JSONL framing rules (LF-only) |

Default: **RPC subprocess** (pi documents strict JSONL framing; Node `readline`
is not compliant because it splits on U+2028/U+2029 — we split on `\n` only).
SDK embed stays an option behind the same internal interface.

## Mapping concerns

### Session model

- OpenCode: one server, many sessions, sessions belong to a directory/project.
- pi: one process per session; session persistence as JSONL files
  (`--session-dir`, `switch_session`, `fork`).
- Adapter owns a process pool keyed by session id, and a directory registry
  mapping OpenCode "project/directory" to pi working directory + session dir.

### Event translation

| OpenCode (SSE `event`) | pi (stdout JSONL) |
|---|---|
| `message.updated` / `message.part.updated` | `message_update` (`assistantMessageEvent`: `text_delta` etc.) |
| `message.part.updated` (tool part) | `message_update` (`toolcall_start`/`toolcall_delta`/`toolcall_end`) + `turn_end` (`toolResults[]` by `toolCallId`) — **M2** |
| `session.status` / `session.idle` | turn lifecycle events (`agent_start`/`agent_end`-family) |
| `permission.asked` | pi extension-UI sub-protocol (`extension_ui_request`/`extension_ui_response`) — semantics differ, map conservatively |
| `session.error` | `extension_error`, RPC error responses |

### Capability gaps to decide explicitly

- **Permissions/questions**: OpenCode has permission prompts and elicitation;
  pi handles interactive prompts through its extension-UI protocol. The
  adapter must map or auto-resolve these deterministically.
- **Todos / file diffs**: OpenCode exposes todo and file-diff state that
  OpenChamber renders. pi emits tool-call events; the adapter reconstructs
  file-change state from edit/write tool calls.
- **Models/providers**: OpenCode `/provider` and `/config` endpoints vs pi's
  `get_available_models` / `set_model`. Adapter translates at the boundary.
- **Compaction**: pi `compact` / `set_auto_compaction` ↔ OpenCode
  `session.summarize`.

## Milestones

1. **M0 — API inventory**: enumerate the exact OpenCode endpoints/event types
   OpenChamber consumes (see `docs/api-surface.md`).
2. **M1 — Session CRUD + prompt round-trip**: create session, send prompt,
   stream text deltas as SSE, abort. Enough for OpenChamber to show a chat.
3. **M2 — Tool calls & file changes**: translate tool events; diffs visible.
   ✅ tool parts (2026-09-21): streamed `toolcall_*` → OpenCode tool parts
   with the SDK v2 `ToolState` union; results matched by `toolCallId` from
   `turn_end.toolResults`; dangling parts finalized as errors on abort/exit.
   File-diff surfacing beyond tool parts is still open.
4. **M3 — Permissions/questions bridge**.
5. **M4 — Model listing/switching, session stats, compaction**.
6. **M5 — Packaging**: `npx openchamber-pi`, docs, CI, npm publish.

## Reference sources

Upstream repos are shallow-cloned into `reference/` (gitignored) for local
inspection:

- `reference/openchamber` — https://github.com/openchamber/openchamber
- `reference/pi-mono` — https://github.com/badlogic/pi-mono

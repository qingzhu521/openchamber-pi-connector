# OpenCode API surface consumed by OpenChamber

Inventory extracted from `reference/openchamber` (commit: shallow clone of
`main`, 2026-09-20). Sources:

- `packages/ui/src/sync/event-reducer.ts` — authoritative SSE event contract.
- `packages/ui/src/sync/session-actions.ts`, `bootstrap.ts`,
  `stores/globalSessions.ts`, `lib/api/` — SDK call sites via
  `@opencode-ai/sdk/v2`.

## REST/SDK methods used

### Sessions (core)

| SDK method | Purpose in OpenChamber | pi counterpart |
|---|---|---|
| `session.list` | session list per directory | scan pi `--session-dir` JSONL files |
| `session.create` | new session | spawn `pi --mode rpc` (fresh session) |
| `session.get` | session detail | RPC `get_state` |
| `session.update` | rename/metadata | RPC `set_session_name` |
| `session.delete` | delete session | kill process + remove session file |
| `session.messages` | load message history | RPC `get_messages` |
| `session.promptAsync` | send prompt (async) | RPC `prompt` |
| `session.abort` | stop generation | RPC `abort` |
| `session.fork` | fork from a message | RPC `fork` / `get_fork_messages` |
| `session.revert` / `session.unrevert` | undo file changes | **gap** — pi has no revert; map to git or reject |
| `session.summarize` | compact context | RPC `compact` |
| `session.status` | busy/idle map | derive from RPC events |
| `session.todo` | todo list rendering | **gap** — reconstruct or stub empty |
| `session.shell` | run shell in session ctx | RPC `bash` |
| `session.command` | slash commands | RPC `prompt` with `/cmd` or `get_commands` |
| `session.share` / `session.unshare` | share links | **n/a** — stub/404 |

### Permissions & questions

| SDK method | pi counterpart |
|---|---|
| `permission.list` / `permission.reply` | extension-UI sub-protocol (`select`/`confirm` requests) |
| `question.list` / `question.reply` / `question.reject` | extension-UI `input`/`select` requests |

### Project / config / misc

| SDK method | pi counterpart |
|---|---|
| `project.current` / `project.list` | adapter directory registry |
| `config.get` / `config.update` | adapter config (pi flags, session dirs) |
| `config.providers` | RPC `get_available_models` (translated) |
| `command.list` | RPC `get_commands` |
| `app.agents` | static pi agent descriptor |
| `path.get`, `vcs.get`, `lsp.status`, `find.*`, `file.*` | filesystem/git direct (adapter-side) |
| `auth.set`, `provider.oauth`, `mcp.connect/disconnect` | stub or proxy to pi config |

## SSE event contract (event-reducer.ts)

The reducer handles exactly these `type` values; the adapter must emit
compatible payloads for the subset it supports:

```
server.connected            session.created           session.updated
session.deleted             session.status            session.idle
session.error               session.diff              message.updated
message.removed             message.part.updated      message.part.delta
message.part.removed        permission.asked          permission.replied
question.asked              question.replied          question.rejected
todo.updated                project.updated           vcs.branch.updated
lsp.updated                 server.instance.disposed  global.disposed
```

Minimum viable set for M1 (chat works): `server.connected`,
`session.created`, `session.updated`, `session.status`, `session.idle`,
`session.error`, `message.updated`, `message.part.updated`,
`message.part.delta`.

## pi RPC → OpenCode event mapping (draft)

| pi stdout event | OpenCode SSE |
|---|---|
| `message_update` / `assistantMessageEvent: text_delta` | `message.part.delta` + `message.part.updated` |
| tool call start/end events | `message.part.updated` (tool part) |
| `bash_execution_update` | `message.part.updated` (bash part) |
| turn start / turn end | `session.status` (busy) / `session.idle` |
| `extension_ui_request` (confirm/select/input) | `permission.asked` / `question.asked` |
| `extension_error` / RPC error response | `session.error` |
| `get_entries` / `get_tree` (polled or on fork) | `session.updated` |

## Open items

- [ ] Exact mechanism OpenChamber uses to point at an *external* OpenCode
      server URL (managed vs external lifecycle lives in `packages/web`);
      document the user-facing setup steps.
- [ ] Payload field-level schemas for each event type (from
      `@opencode-ai/sdk/v2` types).
- [ ] Whether OpenChamber's WebSocket relay (`global/event/ws`) re-broadcasts
      opencode SSE server-side in `packages/web`, or the UI subscribes to
      opencode directly — determines where the adapter plugs in.

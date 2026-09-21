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
| `session.promptAsync` | send prompt (async) | RPC `prompt`. **Echo contract** (verified against OpenChamber's event-reducer): reuse the client's optimistic `messageID` from the body for the user message and emit `message.updated` + `message.part.updated` (user text part) so the optimistic insert reconciles in place instead of rendering twice. |
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
| `assistantMessageEvent: toolcall_start/delta/end` | `message.part.updated` (tool part; **M2 implemented** — pending `{raw}` accumulates the streamed JSON fragments, running carries parsed `arguments`, result lands at `turn_end`) |
| `turn_end` (`toolResults[]`) | `message.part.updated` (tool part → completed `{output}` / error per `isError`, matched by `toolCallId`) |
| `bash_execution_update` | (unmapped — folded into tool parts above) |
| turn start / turn end | `session.status` (busy) / `session.idle` |
| `extension_ui_request` (confirm/select/input) | `permission.asked` / `question.asked` (M1: auto-cancel) |
| `extension_error` / RPC error response | `session.error` |
| `get_entries` / `get_tree` (polled or on fork) | `session.updated` |

Tool part `state` mirrors `@opencode-ai/sdk` v2 (1.18.31) `ToolState` —
discriminated union on `.status` with `input`/`output`/`title` inside the
state object (verified against the locally installed
`dist/v2/gen/types.gen.d.ts`). Live-observed pi shapes (probe, 2026-09-21):
`toolcall_start {contentIndex, id, toolName}` →
`toolcall_delta {delta}` (JSON argument fragments) →
`toolcall_end {toolCall:{id, name, arguments}}` →
`turn_end {toolResults:[{toolCallId, content:[{type:"text",text}], isError}]}`.

## Open items

- [x] How OpenChamber launches the agent backend: it spawns
      `$OPENCODE_BINARY serve --hostname H --port P` (managed lifecycle in
      `packages/web/server/lib/opencode/lifecycle.js`), parses the stdout line
      `opencode server listening on <url>`, then health-checks
      `GET /global/health`. `settings.opencodeBinary` (settings.json) is the
      reliable override; combine with `OPENCHAMBER_DATA_DIR` for an isolated
      test profile.
- [ ] Payload field-level schemas for each event type (from
      `@opencode-ai/sdk/v2` types).
- [x] The UI uses `@opencode-ai/sdk/v2`; note the v2 surface differs from v1
      (`question.list` → `GET /question`, `permission.list` →
      `GET /permission`, session list → `GET /experimental/session`,
      `GET /path`, `GET /vcs` are all probed during bootstrap and must exist).

## Bootstrap probes observed live (OpenChamber 1.21.0)

These are called at startup and 404s surface as console errors or blocked
send ("provider or model not selected"):

| Endpoint | Minimum viable response |
|---|---|
| `GET /provider` | `{all: Provider[], default: {providerID: modelID}, connected: string[]}` |
| `GET /config/providers` | `{providers: Provider[], default: {...}}` |
| `GET /question` | `[]` |
| `GET /permission` | `[]` |
| `GET /lsp` | `[]` |
| `GET /formatter` | `[]` |
| `GET /experimental/session` | `Session[]` (all directories) |
| `GET /path` | `{home, state, config, worktree, directory}` |
| `GET /vcs` | `{}` or `{branch}` |
| `GET /agent` | at least one primary agent |
| `GET /global/health` | any 200 JSON |

Gotcha: OpenChamber's model picker ignores `default` when it can't match it
and silently falls back to the **first listed provider/model** — the adapter
sorts pi's active model to the front for this reason.

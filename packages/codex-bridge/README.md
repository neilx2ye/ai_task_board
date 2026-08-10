# AI Task Board Codex Bridge

`ai-task-board-codex-bridge` is the device-level Codex companion for AI Task
Board. One long-running Bridge process represents one device/AI Connection. It
starts the local `codex app-server` over stdio, discovers non-archived top-level
Codex threads, maps each thread to a Board Session, receives reserved work, and
streams supported progress back to the Board.

The Bridge uses the Board REST API and authenticated SSE directly. The Board
MCP server is optional and is not required for Bridge operation.

## Run the 0.3 CLI

Node.js 18 or newer and a compatible, logged-in `codex` CLI are required. Run
the Bridge as the same OS user that owns the local Codex data and workspaces:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_WORKING_DIRECTORY='/path/to/a/safe/start-directory' \
npx --yes ai-task-board-codex-bridge@0.3.0
```

`CODEX_THREAD_ID` is optional. By default, `CODEX_THREAD_SCOPE=cwd` manages only
top-level threads whose recorded cwd exactly equals `CODEX_WORKING_DIRECTORY`,
up to 50 recent matches. Set `CODEX_THREAD_SCOPE=all` only as an explicit,
high-risk opt-in to cross-project discovery. `CODEX_THREAD_ID` overrides the
scope with one exact existing-thread compatibility filter:

```bash
CODEX_THREAD_ID='REPLACE_WITH_LOCAL_THREAD_ID' \
npx --yes ai-task-board-codex-bridge@0.3.0
```

`CODEX_MAX_THREADS` controls the inventory limit, while
`CODEX_MAX_CONCURRENT_TURNS` controls device-wide turn concurrency (default
`2`). Session names do not upload the local thread title or first prompt by
default; they use the cwd basename plus a short thread ID. Set
`CODEX_BRIDGE_INCLUDE_THREAD_TITLES=true` only after explicitly accepting that
metadata disclosure. Inventory still uploads each thread ID, absolute working
directory, and model label to the Board Workspace.

## Optional Web configuration

Web configuration is disabled locally by default. Enable it on the device with
`CODEX_BRIDGE_WEB_CONFIG=true`; the Bridge then checks `/api/ai/config` every
10 seconds and applies safe runtime changes without restarting systemd. The
interval can be set with `AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS` from `1000` to
`600000` milliseconds.

The Web console may enable or pause this Bridge, hide or show thread titles,
and lower the thread and concurrency limits. `enabled=false` stops all Session
workers, releases their work, and uploads an authoritative empty inventory,
while keeping the device Bridge process alive so it can be re-enabled. A
concurrency reduction lets active turns finish and only delays new turns.

The device environment remains the immutable security boundary:

- Web values for `max_threads` and `max_concurrent_turns` are clamped to the
  local `CODEX_MAX_THREADS` and `CODEX_MAX_CONCURRENT_TURNS` maxima.
- Web title upload is denied unless
  `CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES=true` or the device already opted in
  with `CODEX_BRIDGE_INCLUDE_THREAD_TITLES=true`.
- The Board cannot change the URL/token, Codex executable, working directory,
  thread scope/fixed thread, permission mode, or approval mode.

The Bridge reports its effective settings, local constraints, applied version,
and any clamp/gate warning back to the Board. It also holds a renewable runtime
lease so a second Bridge using the same Connection waits instead of overwriting
status or starting duplicate workers. With Web configuration disabled, these
reports continue as lease heartbeats so a new Web console can explain the local
gate, but the Bridge ignores returned desired settings. A missing config
endpoint is tolerated in that mode. When Web configuration is explicitly
enabled, a 404 is fatal so a deployment cannot appear remotely managed when it
is not. Graceful shutdown releases the runtime lease; after an unclean exit it
expires within 30 seconds.
A replacement process waits without starting workers while that old lease is
still valid. Lease renewal runs independently from inventory/config application,
at least every 10 seconds, and a local safety deadline stops workers before a
lease can expire during a prolonged Board outage. The deprecated-Board 404
fallback cannot provide this single-runtime fence.

The Bridge forwards agent-message, displayable reasoning-summary, and command
output deltas, plus completed tool/file/plan events. Stream chunks are batched
for roughly 500 ms or 8 KiB. It never exposes hidden raw
chain-of-thought. `CODEX_BRIDGE_PERMISSION_MODE=safe` is the default execution
profile: it overrides resumed turns to `on-request` / user-reviewed /
workspace-write, limits writable roots to that thread's absolute cwd, excludes
implicit tmp roots, and disables network access. This primarily constrains
writes and network; it does not prevent reading files already readable by the
same UID. The `inherit` mode can inherit danger-full-access or broader roots and is a
high-risk opt-in. Separately, server-initiated approval requests are denied by
default. `CODEX_BRIDGE_APPROVAL_MODE` controls only those request decisions; it
does not configure the sandbox. Its `accept` and `accept-session` modes
automatically approve local actions and are high risk.

There is currently no reliable running-turn steer, Web-triggered interrupt, or
Web approval flow. Messages sent while a thread is busy queue as later Tasks.
Execution is at-least-once, so irreversible actions still need their own
idempotency or explicit human confirmation.

Keep the Connection Token in a secret store or protected environment file. Do
not pass it as a command-line argument. The Bridge removes that token from the
App Server child environment, but processes under the same OS UID are not a
strong token-isolation boundary. Use a separate UID and/or a token proxy when
strong isolation is required. Board schema and `/api/ai/sessions/sync` must be
upgraded before starting 0.3; there is no 404 fallback to the old registration
API. For persistent use, pin version `0.3.0`
in systemd, launchd, or another process manager; the npm CLI does not install or
enable a service itself. Run only one Bridge for the same device/Connection, and
do not let another TUI, IDE, or automation writer submit turns to a managed
thread at the same time.

Use `npx --yes ai-task-board-codex-bridge@0.3.0 --help` for the complete
environment-variable list.

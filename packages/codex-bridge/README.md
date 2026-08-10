# AI Task Board Codex Bridge

`ai-task-board-codex-bridge` is the device-level Codex companion for AI Task
Board. One long-running Bridge process represents one device/AI Connection. It
starts the local `codex app-server` over stdio, discovers non-archived top-level
Codex threads, maps each thread to a Board Session, receives reserved work, and
streams supported progress back to the Board.

The Bridge uses the Board REST API and authenticated SSE directly. The Board
MCP server is optional and is not required for Bridge operation.

## Run the 0.2 CLI

Node.js 18 or newer and a compatible, logged-in `codex` CLI are required. Run
the Bridge as the same OS user that owns the local Codex data and workspaces:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_WORKING_DIRECTORY='/path/to/a/safe/start-directory' \
npx --yes ai-task-board-codex-bridge@0.2.0
```

`CODEX_THREAD_ID` is optional. By default, `CODEX_THREAD_SCOPE=cwd` manages only
top-level threads whose recorded cwd exactly equals `CODEX_WORKING_DIRECTORY`,
up to 50 recent matches. Set `CODEX_THREAD_SCOPE=all` only as an explicit,
high-risk opt-in to cross-project discovery. `CODEX_THREAD_ID` overrides the
scope with one exact existing-thread compatibility filter:

```bash
CODEX_THREAD_ID='REPLACE_WITH_LOCAL_THREAD_ID' \
npx --yes ai-task-board-codex-bridge@0.2.0
```

`CODEX_MAX_THREADS` controls the inventory limit, while
`CODEX_MAX_CONCURRENT_TURNS` controls device-wide turn concurrency (default
`2`). Session names do not upload the local thread title or first prompt by
default; they use the cwd basename plus a short thread ID. Set
`CODEX_BRIDGE_INCLUDE_THREAD_TITLES=true` only after explicitly accepting that
metadata disclosure. Inventory still uploads each thread ID, absolute working
directory, and model label to the Board Workspace.

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
upgraded before starting 0.2; there is no 404 fallback to the old registration
API. For persistent use, pin version `0.2.0`
in systemd, launchd, or another process manager; the npm CLI does not install or
enable a service itself. Run only one Bridge for the same device/Connection, and
do not let another TUI, IDE, or automation writer submit turns to a managed
thread at the same time.

Use `npx --yes ai-task-board-codex-bridge@0.2.0 --help` for the complete
environment-variable list.

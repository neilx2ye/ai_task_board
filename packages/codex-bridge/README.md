# AI Task Board Codex Bridge

`ai-task-board-codex-bridge` is the device-level Codex companion for AI Task
Board. One long-running Bridge process represents one device/AI Connection. It
starts the local `codex app-server` over stdio, discovers non-archived top-level
Codex threads, maps each thread to a Board Session, receives reserved work, and
streams supported progress back to the Board.

The Bridge uses the Board REST API and authenticated SSE directly. The Board
MCP server is optional and is not required for Bridge operation.

## Run the 0.6 CLI

Node.js 18 or newer and a compatible, logged-in `codex` CLI are required. Run
the Bridge as the same OS user that owns the local Codex data and workspaces:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_WORKING_DIRECTORY='/path/to/a/safe/start-directory' \
npx --yes ai-task-board-codex-bridge@0.6.0
```

`CODEX_THREAD_ID` is optional. By default, `CODEX_THREAD_SCOPE=cwd` manages only
top-level threads whose recorded cwd exactly equals `CODEX_WORKING_DIRECTORY`,
up to 50 recent matches. Set `CODEX_THREAD_SCOPE=all` only as an explicit,
high-risk opt-in to cross-project discovery. `CODEX_THREAD_ID` overrides the
scope with one exact existing-thread compatibility filter:

```bash
CODEX_THREAD_ID='REPLACE_WITH_LOCAL_THREAD_ID' \
npx --yes ai-task-board-codex-bridge@0.6.0
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
enable bounded history sync, and lower the thread, concurrency, and history
limits. `enabled=false` stops all Session
workers, releases their work, and uploads an authoritative empty inventory,
while keeping the device Bridge process alive so it can be re-enabled. A
concurrency reduction lets active turns finish and only delays new turns.

The device environment remains the immutable security boundary:

- Web values for `max_threads` and `max_concurrent_turns` are clamped to the
  local `CODEX_MAX_THREADS` and `CODEX_MAX_CONCURRENT_TURNS` maxima.
- Web title upload is denied unless
  `CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES=true` or the device already opted in
  with `CODEX_BRIDGE_INCLUDE_THREAD_TITLES=true`.
- Web history sync is denied unless the device explicitly sets
  `CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true`. The requested recent-turn count is
  clamped to `CODEX_BRIDGE_MAX_HISTORY_TURNS` (default `50`, maximum `200`).
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

## Web Thread management

Bridge 0.5 lets a Workspace owner create, rename, and delete Codex Threads from
the Web Console. The Board stores each request as a leased command; only the
Bridge process holding that connection's runtime lease may execute it. New
Threads always use the locally configured `CODEX_WORKING_DIRECTORY`, and the
Web cannot choose an arbitrary device path. Rename and delete commands only
target Threads already present in the Bridge's managed inventory. Fixed
`CODEX_THREAD_ID` mode rejects create and delete commands.

A delete request is accepted only when the Thread has no active or reserved
work. It immediately hides and fences the Board Session, then calls the Codex
App Server's hard-delete method. Compatible older App Server builds that lack
hard delete fall back to archive. Board audit/history rows are retained.

## Optional bounded history sync

History upload is off by default and requires both
`CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true` on the device and `sync_history=true` in
Web configuration. Bridge 0.5 scans at most the configured number of recent
completed turns for ordinary CLI/VS Code threads in a separate, cancellable,
bounded background loop. Runtime-lease renewal, inventory, and live turns do
not wait for this scan.

Only text from `userMessage`, the final `agentMessage`, and provider-supplied
`reasoning.summary` are imported. A turn carrying a non-empty persisted
`clientUserMessageId` is skipped because it came from Board live execution.
Images, local-image/skill paths, raw `reasoning.content`, commands and their
output, diffs, MCP arguments/results, and every other tool item are discarded
locally while persisted items are read in pages. The Bridge scans at most 10,000
raw items in one turn and retains at most 500 whitelisted activities across one
snapshot. A turn that would cross either hard safety boundary is not partially
imported; the snapshot stops with `partial` and a `local-safety-cap` marker.
That marker reports local truncation and is not a resumable App Server cursor.
Text passes through the Bridge redactor and a UTF-safe 50,000-character limit
before upload. Stable thread/turn/item references make any rescan idempotent. An
unchanged `thread.updatedAt` plus turn-limit signature is scanned only once per
Bridge process; a changed thread, changed limit, or process restart can enqueue
another idempotent scan. Batches contain at most 100 items and 512 KiB. Other
scan/import failures use bounded backoff, update only the per-Session history
status, and do not stop the main Bridge.

Imported history is append-only on the Board. Turning history sync off or
lowering the recent-turn limit stops later imports but does not delete content
that was already uploaded. Remove that data through the Board's applicable
Workspace/data deletion flow when required.

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

Version 0.6 forwards blocking Codex `requestUserInput` prompts to the Web
Console as structured controls. The App Server request, turn, task claim, and
heartbeats remain active while the Bridge polls; submitting the Web answer
resolves that same request instead of creating a later turn. Answer values are
kept out of public messages, and secret inputs are cleared when the claim ends.

Keep the Connection Token in a secret store or protected environment file. Do
not pass it as a command-line argument. The Bridge removes that token from the
App Server child environment, but processes under the same OS UID are not a
strong token-isolation boundary. Use a separate UID and/or a token proxy when
strong isolation is required. Board schema and `/api/ai/sessions/sync` must be
upgraded before starting 0.6; there is no 404 fallback to the old registration
API. For persistent use, pin version `0.6.0`
in systemd, launchd, or another process manager; the npm CLI does not install or
enable a service itself. Run only one Bridge for the same device/Connection, and
do not let another TUI, IDE, or automation writer submit turns to a managed
thread at the same time.

Use `npx --yes ai-task-board-codex-bridge@0.6.0 --help` for the complete
environment-variable list.

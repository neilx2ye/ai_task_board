# AI Task Board Bridge

`ai-task-board-bridge` is the single public npm package for AI Task Board's
device companions. Its interactive installer asks whether to install Codex
Bridge, Kimi Bridge, Antigravity Bridge, or a combination. The three runtimes
remain separate processes with separate Board Connections, tokens,
working-directory allowlists, and systemd services.

Codex Bridge starts the local `codex app-server` over stdio, discovers
non-archived top-level Codex threads, maps each thread to a Board Session,
receives reserved work, and streams supported progress back to the Board. Kimi
Bridge starts the logged-in Kimi Code ACP server and manages real Kimi Sessions;
it does not expose Kimi as a fake Codex model. Antigravity Bridge drives the
logged-in Google Antigravity CLI (`agy`) through its official headless
`stream-json` interface and keeps per-Thread conversation continuity; it never
reads Google's private conversation databases.

The Bridge uses the Board REST API and authenticated SSE directly. The Board
MCP server is optional and is not required for Bridge operation.

## Unified Linux setup

Node.js 18 or newer is required. Run setup as the same OS user that owns the
selected agent login and workspaces:

```bash
npx --yes ai-task-board-bridge@1.4.0 setup
```

The first prompt offers `Codex Bridge`, `Kimi Bridge`, `Antigravity Bridge`,
`both`, and `all`. Automation or repeat installs can bypass that first prompt:

```bash
npx --yes ai-task-board-bridge@1.4.0 setup codex
npx --yes ai-task-board-bridge@1.4.0 setup kimi
npx --yes ai-task-board-bridge@1.4.0 setup antigravity
npx --yes ai-task-board-bridge@1.4.0 setup both
npx --yes ai-task-board-bridge@1.4.0 setup all
```

Installing a combination runs the selected setup flows in sequence. Create a
separate Board Connection with the matching platform for each runtime; a token
for one runtime must not be reused for another. The public tarball embeds the
private Kimi and Antigravity runtimes, so no second npm package needs to be
published or installed.

`setup` always finishes by installing and starting a systemd user service; it
never leaves a Bridge running inside the `npx` process. When stdin/stdout is
not a TTY (for example an SSH command or CI script), `setup codex`,
`setup kimi`, and `setup antigravity` install the same services from
environment variables without prompting. The `both`/`all` targets remain
interactive because each runtime needs its own Connection Token.

### Codex setup

The Codex setup wizard asks for the Board URL and hidden Connection Token.
Working directories are optional: new installs default to Web-side management,
so project directories are added later in the Board's "AI 连接 → Bridge
设置 / 新建项目" instead of being typed during setup. Choosing the local mode
instead fixes a device allowlist at install time. The wizard also collects the
Codex home and executable, custom-provider credential environment variables,
thread limits, and permission/approval modes. It then installs and starts
`ai-task-board-bridge.service` in the effective user's systemd user manager.
Running with no command also enters setup in a TTY when either required Board
setting is missing.

Choosing Web-side directory management enables both
`CODEX_BRIDGE_WEB_CONFIG=true` and
`CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES=true` in the installed
environment file. The generated unit still needs an existing
`WorkingDirectory=` for the App Server startup fallback, so setup uses the
user's home directory for that unit field only; it is not registered as a
managed project directory and no `CODEX_WORKING_DIRECTORY` or
`CODEX_WORKING_DIRECTORIES` is written.

Non-interactive Codex service install uses the same safe defaults as the
wizard:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
npx --yes ai-task-board-bridge@1.4.0 setup codex
```

Without `CODEX_WORKING_DIRECTORY` or `CODEX_WORKING_DIRECTORIES` the
non-interactive install also defaults to Web-side directory management. Pass
either variable to fix a local allowlist instead.

The generated unit has no `User=` directive: a systemd user manager already
runs as its owning UID. Setup explicitly binds that user's `HOME` and
`CODEX_HOME`, captures an absolute Codex executable, stores secrets in a `0600`
EnvironmentFile, and copies the current package to the user's XDG data directory
so the service does not depend on an ephemeral npx cache. Do not use `sudo npx`
unless a root-owned service and root's Codex configuration are actually desired.
Each Linux user can install an independent unit with the same name; use separate
Board Connections unless only one of them should acquire the runtime lease.
Provider variables referenced by `env_key` or `env_http_headers` in
`config.toml` are detected by name and confirmed with hidden input; setup does
not copy the user's entire shell environment.

New interactive installs default to `safe` permissions and `decline` approvals.
The wizard requires an explicit selection before installing, and rerunning it
updates the configuration and restarts the service. Upgrades disable the legacy
`ai-task-board-codex-bridge.service` before starting
`ai-task-board-bridge.service`, with rollback if the new service fails to start.

## Foreground run mode

The original environment-variable interface remains available for other
process managers and temporary runs. Unlike `setup`, it does not install a
service, so a terminated `npx` process takes the Bridge down with it:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_WORKING_DIRECTORY='/path/to/a/safe/start-directory' \
npx --yes ai-task-board-bridge@1.4.0 run codex
```

> **High-risk foreground defaults:** when these values are omitted, the Bridge uses
> `CODEX_BRIDGE_PERMISSION_MODE=danger-full-access` (no sandbox) together with
> `CODEX_BRIDGE_APPROVAL_MODE=accept` (automatic device-side approval). Use
> this combination only when the workspace, Codex configuration, and Connection
> users are trusted. Set `CODEX_BRIDGE_PERMISSION_MODE=safe` explicitly when
> writes and network access must be constrained.

`CODEX_THREAD_ID` is optional. By default, `CODEX_THREAD_SCOPE=cwd` manages only
top-level threads whose recorded cwd exactly equals a locally allowlisted directory,
up to 50 recent matches. Set `CODEX_THREAD_SCOPE=all` only as an explicit,
high-risk opt-in to cross-project discovery. `CODEX_THREAD_ID` overrides the
scope with one exact existing-thread compatibility filter:

```bash
CODEX_THREAD_ID='REPLACE_WITH_LOCAL_THREAD_ID' \
npx --yes ai-task-board-bridge@1.4.0
```

Bridge 0.7 and later can manage several exact working directories in one process:

```bash
CODEX_WORKING_DIRECTORIES='[{"key":"main","name":"Main App","path":"/srv/main"},{"key":"docs","name":"Docs","path":"/srv/docs"}]' \
CODEX_THREAD_SCOPE='cwd' \
npx --yes ai-task-board-bridge@1.4.0
```

The JSON array accepts 1 to 100 unique `{key,name?,path}` entries. Its first
entry is the App Server startup and local fallback directory. The Board stores
and returns only a selected key in Web create commands; the Bridge resolves that
key against the currently effective list.

`CODEX_MAX_THREADS` controls the device-wide inventory limit (default `50`,
range `1..500` across all configured directories).
`CODEX_MAX_CONCURRENT_TURNS` remains a compatibility startup value (default
`2`) before Web configuration is applied; once enabled, the Web value directly
controls device-wide turn concurrency from `1..32`. Session names do not upload
the local thread title or first prompt by default; they use the cwd basename plus
a short thread ID. Set
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
enable bounded history sync, lower the thread and history limits, set device-wide
turn concurrency directly,
and—only after a separate local opt-in—replace the effective working-directory
list. `enabled=false` stops all Session
workers, releases their work, and uploads an authoritative empty inventory,
while keeping the device Bridge process alive so it can be re-enabled. A
concurrency reduction lets active turns finish and only delays new turns.

The device environment remains the immutable security boundary:

- Web `max_threads` is clamped to the local `CODEX_MAX_THREADS` maximum.
- Web `max_concurrent_turns` directly sets device-wide concurrency in the
  supported `1..32` range; it is not clamped by a separate local maximum.
- Web title upload is denied unless
  `CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES=true` or the device already opted in
  with `CODEX_BRIDGE_INCLUDE_THREAD_TITLES=true`.
- Web history sync is denied unless the device explicitly sets
  `CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true`. The requested recent-turn count is
  clamped to `CODEX_BRIDGE_MAX_HISTORY_TURNS` (default `50`, maximum `200`).
- Web working-directory configuration is denied unless the device explicitly
  sets `CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES=true`. A remote list must
  contain 1 to 100 unique entries with absolute paths that already exist and are
  directories. An entry may carry `create_if_missing: true`, which authorizes
  the device to create the path with `mkdir -p` before validating it; without
  the flag the check stays fail-closed. Missing, null, or locally denied
  remote values retain the immutable `CODEX_WORKING_DIRECTORIES` /
  `CODEX_WORKING_DIRECTORY` startup list.
- The Board cannot change the URL/token, Codex executable, thread scope/fixed
  thread, permission mode, approval mode, or the immutable local fallback list.

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

## Web-triggered Bridge upgrades

The Board can ask a device to move its Bridge to a newer npm release: each
configuration exchange response may carry `desired_bridge_version`, and a
Bridge that sees a newer, valid semver target upgrades itself. The Board only
transports the version string; the code is always downloaded from the npm
registry with `npm pack`, which verifies the registry integrity metadata
before anything is installed.

Remote upgrades are disabled by default and require two local gates:

- `AI_TASK_BOARD_ALLOW_REMOTE_UPDATE=true` in the Bridge environment (for a
  systemd install, add it to the `0600` environment file and restart the
  service), and
- the Bridge process must run under systemd (`INVOCATION_ID` is set). A
  foreground Bridge logs a one-time stderr hint per target version and keeps
  running the old code; upgrade it manually by rerunning
  `npx --yes ai-task-board-bridge@1.4.0 setup` for the same runtime.

With both gates satisfied, the Bridge downloads
`ai-task-board-bridge@<version>` (120-second timeout), extracts the tarball
into a staging directory, installs this runtime's `dist` subtree into
`versions/<version>/` next to the current one, smoke-tests
`node versions/<version>/dist/cli.js --version` (10-second timeout; the output
must contain the target version), rewrites the systemd unit `ExecStart` to the
new runtime while preserving the existing `HOME`, `CODEX_HOME`,
`WorkingDirectory`, and `EnvironmentFile` settings, runs
`systemctl --user daemon-reload`, and exits with code 75 so
`Restart=on-failure` starts the new version about five seconds later.

A failed attempt cleans up staging, keeps the old version running, and reports
the error in the next configuration exchange's `error` field, which the Board
surfaces in the Bridge settings dialog. The same target version is not retried
until the Board changes it or the Bridge process restarts, so a broken release
cannot cause a retry storm.

Old version directories are kept for manual rollback. To roll back, point the
unit's `ExecStart` back at the previous runtime and restart the service:

```bash
$EDITOR ~/.config/systemd/user/ai-task-board-bridge.service
# ExecStart="…/node" "…/.local/share/ai-task-board/codex-bridge/versions/<previous>/dist/cli.js" "run"
systemctl --user daemon-reload
systemctl --user restart ai-task-board-bridge.service
```

## Device identity

Every session-inventory sync (`POST /api/ai/sessions/sync`) carries two flat
fields: `device_id` and `device_label` (the OS hostname). The device ID is a
UUID generated on first Bridge start and persisted to
`$XDG_CONFIG_HOME/ai-task-board/device-id` (default
`~/.config/ai-task-board/device-id`) with `0600` permissions. All AI Task
Board bridges on the same host share that file, so the Board can group the
Codex, Kimi, and Antigravity runtimes of one device. If the file cannot be
written, the Bridge logs a warning and runs with an ephemeral ID.

## Web Thread management

Bridge 0.5 lets a Workspace owner create, rename, and delete Codex Threads from
the Web Console. The Board stores each request as a leased command; only the
Bridge process holding that connection's runtime lease may execute it. New
Threads use the effective directory selected in the hierarchy. Thread-create
commands still carry only its stable key, never an absolute path. Rename and delete commands only
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

The user's `userMessage` and the final `agentMessage` are imported. A turn
carrying a non-empty persisted `clientUserMessageId` is skipped because it came
from Board live execution.
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

Imported history is append-only on the Board, and historical user prompts are
visible to members who can access the Workspace. Turning history sync off or
lowering the recent-turn limit stops later imports but does not delete content
that was already uploaded. Remove that data through the Board's applicable
Workspace/data deletion flow when required.

The Bridge forwards only agent-message deltas and completed replies. Stream
chunks are batched for roughly 500 ms or 8 KiB. Reasoning summaries, command
output, tool/file/plan events, and usage are not uploaded.
`CODEX_BRIDGE_PERMISSION_MODE=danger-full-access` is the default execution
profile. It explicitly keeps `on-request` / user-reviewed approval handling but
runs without a sandbox, so writes and network access are unrestricted within
the OS user's own permissions. It does not grant root or bypass operating-system
access controls. This default is intended to keep trusted tasks from stalling on
sandbox limits, but it is high risk.

Set `CODEX_BRIDGE_PERMISSION_MODE=safe` explicitly to use `workspace-write`,
limit writable roots to the thread's absolute cwd, exclude implicit tmp roots,
and disable network access. This primarily constrains writes and network; it
does not prevent reading files already readable by the same UID. The `inherit`
mode sends no permission or approval overrides and uses the thread/local Codex
configuration as-is. It may inherit full access, broader writable roots, or a
stricter policy, so treat it as high risk when the local configuration is not
known.

Separately, supported server-initiated approval requests correlated with the
active turn are automatically accepted on the device by the default
`CODEX_BRIDGE_APPROVAL_MODE=accept`, without per-request Web confirmation.
Uncorrelated requests are still denied, blocking `requestUserInput` continues
through the Web Console, and MCP elicitation remains denied. Approval mode does
not configure the sandbox. Use `decline` to deny approval requests or
`accept-session` to extend supported approvals to the session. Automatic
approval is high risk and is not a Web confirmation flow.

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
upgraded before starting 0.8; there is no 404 fallback to the old registration
API. On Linux, use `setup` for a pinned local runtime and systemd user service.
On other platforms, pin version `1.2.0` in launchd or another process manager.
Run only one Bridge for the same device/Connection, and
do not let another TUI, IDE, or automation writer submit turns to a managed
thread at the same time.

Use `npx --yes ai-task-board-bridge@1.4.0 --help` for the complete
environment-variable list.

## Kimi Bridge

Kimi Bridge requires a logged-in Kimi Code CLI and a dedicated Board Connection
whose platform is `Kimi Code`. Interactive setup installs the separate
`ai-task-board-kimi-bridge.service`, stores its token in a `0600` environment
file, and stages the embedded Kimi runtime plus ACP dependencies under the
current user's XDG data directory.

Foreground or non-systemd operation uses the same public npm package:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
KIMI_WORKING_DIRECTORY='/absolute/path/to/project' \
KIMI_BRIDGE_MODE='auto' \
KIMI_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.4.0 run kimi
```

`KIMI_WORKING_DIRECTORIES` accepts 1 to 100 unique exact
`{key,name?,path}` entries. The Bridge dynamically reports Kimi ACP's model and
thought-level catalog. Web creation and deletion operate on real Kimi Sessions;
rename remains hidden because Kimi Code 0.34 does not expose a reliable ACP
rename operation. The Board token is removed from the `kimi acp` child
environment, and only final replies plus bounded completion metadata are
uploaded. Interactive setup defaults to declining extra ACP permissions;
`KIMI_BRIDGE_MODE=yolo` and `KIMI_BRIDGE_APPROVAL_MODE=accept` are explicit
high-risk opt-ins.

## Antigravity Bridge

Antigravity Bridge requires Google Antigravity CLI 1.1.8 or newer with an active
login (`agy update` upgrades; the interactive installer verifies the version) and
a dedicated Board Connection whose platform is `Antigravity`. Interactive setup
installs the separate `ai-task-board-antigravity-bridge.service`, stores its
token in a `0600` environment file, and stages the embedded Antigravity runtime
under the current user's XDG data directory.

Foreground or non-systemd operation uses the same public npm package:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
ANTIGRAVITY_WORKING_DIRECTORY='/absolute/path/to/project' \
ANTIGRAVITY_BRIDGE_MODE='auto' \
ANTIGRAVITY_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.4.0 run antigravity
```

`ANTIGRAVITY_WORKING_DIRECTORIES` accepts 1 to 100 unique exact
`{key,name?,path}` entries. The Bridge dynamically reports the `agy models`
catalog with `low`/`medium`/`high` reasoning efforts. Each Web Thread is a
stable local binding; the first claimed task creates the real agy conversation
and later turns resume it with `--conversation`. Web creation and deletion are
supported, rename stays hidden (no public headless rename API), and deleting a
Thread removes only the Bridge binding so local history is preserved. The Board
token is removed from the `agy` child environment, and only final replies plus
bounded completion metadata are uploaded.
`ANTIGRAVITY_BRIDGE_APPROVAL_MODE=accept` adds
`--dangerously-skip-permissions` and is a high-risk opt-in;
`ANTIGRAVITY_BRIDGE_SANDBOX=true` enables agy's terminal sandbox.

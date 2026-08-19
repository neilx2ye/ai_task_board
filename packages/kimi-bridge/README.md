# AI Task Board Kimi Bridge

This is the private Kimi ACP runtime embedded in the public
`ai-task-board-bridge` tarball. It is not published as a second npm package.
The runtime connects AI Task Board to a real, logged-in Kimi Code installation
and does not add Kimi as a fake Codex model.

One Bridge owns one Board AI Connection. It starts `kimi acp`, discovers Kimi
Sessions whose `cwd` exactly matches the local allowlist, uploads Kimi's live
model catalog, claims work reserved for each Session, and returns the final AI
reply to the matching Board conversation.

## Requirements

- Node.js 18 or newer
- Kimi Code CLI with an active login
- AI Task Board schema/API with Bridge inventory and Web Thread management
- A dedicated Board connection whose platform is `Kimi Code`

## Linux setup

Run setup as the same OS user that owns the Kimi login and target workspaces:

```bash
npx --yes ai-task-board-bridge@1.7.1 setup kimi
```

The wizard asks only for the Board URL (leave it empty to use
`https://task.neilx.online`) and the hidden Connection Token. Working
directories default to Web-side management, which writes
`KIMI_BRIDGE_WEB_CONFIG=true` and
`KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION=true`, leaving the
directory list to the Board's "AI 连接 → Bridge 设置 / 新建项目"; passing
`KIMI_WORKING_DIRECTORY(S)` pins a local allowlist at install time instead.
With `AI_TASK_BOARD_CONNECTION_TOKEN` configured, `setup` runs non-interactively
even in a terminal. The installer writes a `0600` environment file, stages the
CLI and its ACP SDK dependency under the user's XDG data directory, and starts
`ai-task-board-kimi-bridge.service` in that user's systemd manager. It never
puts the Board token on the command line.

The same service can be installed from an SSH command or CI script without a
terminal. Without `KIMI_WORKING_DIRECTORY(S)` the non-interactive install also
defaults to Web directory management; pass either variable to pin a local
allowlist instead. `AI_TASK_BOARD_URL` is optional and defaults to
`https://task.neilx.online`:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
KIMI_WORKING_DIRECTORY='/absolute/path/to/project' \
npx --yes ai-task-board-bridge@1.7.1 setup kimi
```

## Foreground mode

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
KIMI_WORKING_DIRECTORY='/absolute/path/to/project' \
KIMI_BRIDGE_MODE='auto' \
KIMI_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.7.1 run kimi
```

For several projects, set a stable exact-directory allowlist:

```bash
KIMI_WORKING_DIRECTORIES='[{"key":"app","name":"Main App","path":"/srv/app"},{"key":"docs","name":"Docs","path":"/srv/docs"}]'
```

The list accepts 1 to 100 unique `{key,name?,path}` objects. Web creation sends
only a stable directory key; the Bridge resolves it against this local list, so
a command cannot inject an arbitrary device path.

## Remote Web configuration

Set `KIMI_BRIDGE_WEB_CONFIG=true` to let the Workspace Owner apply the Bridge
settings from the Board UI:

- enable/pause the Bridge (paused workers keep heartbeats but claim no new
  turns, and Web Thread creation is rejected);
- change the thread cap and device-wide concurrent-turn cap;
- toggle session-title upload, when the device authorizes it with
  `KIMI_BRIDGE_INCLUDE_SESSION_TITLES=true` or
  `KIMI_BRIDGE_ALLOW_REMOTE_THREAD_TITLES=true`;
- replace the effective working-directory list, when the device authorizes it
  with `KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION=true`.

`KIMI_MAX_THREADS` remains the immutable local ceiling: Web can lower the
runtime cap but never exceed it. `KIMI_MAX_CONCURRENT_TURNS` is the startup
value; with Web configuration enabled the Board owns the live 1..32 limit.
Kimi does not implement thread-history import, so that Codex-specific control
is hidden.

With `KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION=true` a Board-provided
list must contain 1 to 100 unique entries with absolute paths that already
exist and are directories; an entry may carry `create_if_missing: true` to
authorize the device to create the path with `mkdir -p` first. The applied
list replaces the effective allowlist at runtime: the next inventory sync
re-attributes Sessions to the new directories, Sessions outside it are
retired, and Web Thread creation resolves `directory_key` against it. A null
or locally denied remote list restores the immutable
`KIMI_WORKING_DIRECTORIES` startup list.

Every session-inventory sync also reports `device_id` (a UUID generated on
first start and persisted with `0600` permissions to
`$XDG_CONFIG_HOME/ai-task-board/device-id`, shared with the other AI Task
Board bridges on the same host) and `device_label` (the OS hostname), so the
Board can group runtimes by device.

## Web-triggered Bridge upgrades

The Board can ask a device to move its Bridge to a newer npm release: each
configuration exchange response may carry `desired_bridge_version`, and a
Bridge that sees a newer, valid semver target upgrades itself. The Board only
transports the version string; the code is always downloaded from the npm
registry with `npm pack`, which verifies the registry integrity metadata
before anything is installed.

Remote upgrades are enabled by default. The only local requirement is that
the Bridge process runs under systemd (`INVOCATION_ID` is set), because the
update flow rewrites the unit and exits with code 75 for `Restart=on-failure`
to start the new version. A foreground Bridge logs a one-time stderr hint per
target version and keeps running the old code; upgrade it manually by
rerunning `npx --yes ai-task-board-bridge@1.7.1 setup kimi`.

With the systemd requirement satisfied, the Bridge downloads
`ai-task-board-bridge@<version>`, installs the embedded Kimi runtime into
`versions/<version>/` next to the current one, smoke-tests
`node versions/<version>/dist/cli.js --version`, rewrites the systemd unit
`ExecStart` to the new runtime (preserving the existing `HOME`,
`WorkingDirectory`, and `EnvironmentFile` settings), runs
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
$EDITOR ~/.config/systemd/user/ai-task-board-kimi-bridge.service
# ExecStart="…/node" "…/.local/share/ai-task-board/kimi-bridge/versions/<previous>/dist/cli.js" "run"
systemctl --user daemon-reload
systemctl --user restart ai-task-board-kimi-bridge.service
```

## Execution and safety

`KIMI_BRIDGE_MODE` is `auto` by default and may also be `default`, `plan`, or
`yolo`. `yolo` is high risk. Foreground mode defaults
`KIMI_BRIDGE_APPROVAL_MODE` to `accept`, which selects an ACP `allow_once`
choice only for a permission request correlated with an actively claimed Board
task. Uncorrelated requests are rejected. Interactive setup defaults to
`decline` and requires an explicit choice.

The Board token is removed from the `kimi acp` child environment. This is
defense in depth, not isolation from other processes running as the same OS
user. Use a dedicated UID or token proxy when stronger isolation is required.

The Bridge reports only the final assistant message plus bounded completion
metadata. It observes thought/tool/plan updates for counts but does not upload
their raw content. Execution is at-least-once, so irreversible tools still need
their own idempotency.

ACP supports creating and deleting Kimi Sessions. Kimi Code 0.34 does not expose
a reliable ACP rename operation, so the Board UI intentionally hides rename for
Kimi connections. The requested name for a Web-created Session remains the
Board display name.

Use `ai-task-board-bridge --help` for every environment variable.

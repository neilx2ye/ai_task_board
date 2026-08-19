# AI Task Board Antigravity Bridge

This is the private Google Antigravity CLI runtime embedded in the public
`ai-task-board-bridge` tarball. It is not published as a second npm package.
The runtime connects AI Task Board to a real, logged-in Antigravity CLI
installation and drives it through the **official headless `stream-json`
interface** (`agy -p ... --output-format stream-json`). It never reads or
decodes Google's private conversation databases.

One Bridge owns one Board AI Connection. It keeps a local thread registry,
claims work reserved for each Thread, runs the prompt inside the Thread's
working directory with full conversation continuity (`--conversation`), and
returns the final AI reply to the matching Board conversation.

## Requirements

- Node.js 18 or newer
- Google Antigravity CLI 1.1.8 or newer with an active login (`agy update` to
  upgrade; `agy` logs in on first interactive run). Web turns that carry images
  require 1.1.11 or newer.
- AI Task Board schema/API with Bridge inventory and Web Thread management
- A dedicated Board connection whose platform is `Antigravity`

## Linux setup

Run setup as the same OS user that owns the Antigravity login and target
workspaces:

```bash
npx --yes ai-task-board-bridge@1.7.1 setup antigravity
```

The wizard asks only for the Board URL (leave it empty to use
`https://task.neilx.online`) and the hidden Connection Token. Working
directories default to Web-side management, which writes
`ANTIGRAVITY_BRIDGE_WEB_CONFIG=true` and
`ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION=true`, leaving the
directory list to the Board's "AI 连接 → Bridge 设置 / 新建项目"; passing
`ANTIGRAVITY_WORKING_DIRECTORY(S)` pins a local allowlist at install time
instead. With `AI_TASK_BOARD_CONNECTION_TOKEN` configured, `setup` runs
non-interactively even in a terminal. The installer writes a `0600`
environment file, stages the runtime under the user's XDG data directory, and starts
`ai-task-board-antigravity-bridge.service` in that user's systemd manager. It
never puts the Board token on the command line.

The same service can be installed from an SSH command or CI script without a
terminal. Without `ANTIGRAVITY_WORKING_DIRECTORY(S)` the non-interactive
install also defaults to Web directory management; pass either variable to pin
a local allowlist instead. `AI_TASK_BOARD_URL` is optional and defaults to
`https://task.neilx.online`:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
ANTIGRAVITY_WORKING_DIRECTORY='/absolute/path/to/project' \
npx --yes ai-task-board-bridge@1.7.1 setup antigravity
```

## Foreground mode

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
ANTIGRAVITY_WORKING_DIRECTORY='/absolute/path/to/project' \
ANTIGRAVITY_BRIDGE_MODE='auto' \
ANTIGRAVITY_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.7.1 run antigravity
```

For several projects, set a stable exact-directory allowlist:

```bash
ANTIGRAVITY_WORKING_DIRECTORIES='[{"key":"app","name":"Main App","path":"/srv/app"},{"key":"docs","name":"Docs","path":"/srv/docs"}]'
```

The list accepts 1 to 100 unique `{key,name?,path}` objects. Web creation sends
only a stable directory key; the Bridge resolves it against this local list, so
a command cannot inject an arbitrary device path.

## Remote Web configuration

Set `ANTIGRAVITY_BRIDGE_WEB_CONFIG=true` to let the Workspace Owner apply the
Bridge settings from the Board UI:

- enable/pause the Bridge (paused workers keep heartbeats but claim no new
  turns, and Web Thread creation is rejected);
- change the thread cap and device-wide concurrent-turn cap;
- toggle thread-title upload. Antigravity uploads titles by default, so Web
  can only reduce that exposure;
- replace the effective working-directory list, when the device authorizes it
  with `ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION=true`.

`ANTIGRAVITY_MAX_THREADS` is a startup fallback only. With Web configuration
enabled the Board owns the live 1..500 Thread limit and 1..32 turn limit;
neither is clamped to the local environment value. Antigravity does not
implement thread-history import, so that Codex-specific control is hidden.

With `ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION=true` a
Board-provided list must contain 1 to 100 unique entries with absolute paths
that already exist and are directories; an entry may carry
`create_if_missing: true` to authorize the device to create the path with
`mkdir -p` first. The applied list replaces the effective allowlist at
runtime: the next inventory sync re-attributes Threads to the new
directories, Threads outside it are retired, and Web Thread creation resolves
`directory_key` against it. A null or locally denied remote list restores the
immutable `ANTIGRAVITY_WORKING_DIRECTORIES` startup list.

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
rerunning `npx --yes ai-task-board-bridge@1.7.1 setup antigravity`.

With the systemd requirement satisfied, the Bridge downloads
`ai-task-board-bridge@<version>`, installs the embedded Antigravity runtime
into `versions/<version>/` next to the current one, smoke-tests
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
$EDITOR ~/.config/systemd/user/ai-task-board-antigravity-bridge.service
# ExecStart="…/node" "…/.local/share/ai-task-board/antigravity-bridge/versions/<previous>/dist/cli.js" "run"
systemctl --user daemon-reload
systemctl --user restart ai-task-board-antigravity-bridge.service
```

## Execution and safety

`ANTIGRAVITY_BRIDGE_MODE` is `auto` by default and may also be `default`,
`accept-edits` (passes `--mode accept-edits`), or `plan` (passes `--mode
plan`). `ANTIGRAVITY_BRIDGE_APPROVAL_MODE` defaults to `accept`, which adds
`--dangerously-skip-permissions` so agy headless runs auto-approve every tool
call. `decline` relies on the scoped `permissions.allow` rules in the CLI's own
`settings.json`; tools that still need approval are soft-denied per agy's
documented headless behavior. `accept` is high risk.

`ANTIGRAVITY_BRIDGE_SANDBOX=true` adds `--sandbox`, enabling agy's native
terminal sandbox for command execution. `ANTIGRAVITY_PRINT_TIMEOUT` accepts a
Go duration (e.g. `5m`, `90s`, `1h`); by default the Bridge keeps the timeout
just below the Board task lease.

The Board token is removed from the `agy` child environment. This is defense in
depth, not isolation from other processes running as the same OS user. Use a
dedicated UID or token proxy when stronger isolation is required.

The Bridge reports only the final assistant message plus bounded completion
metadata (status, token usage, tool/checkpoint counts). It observes tool steps
for counts but does not upload raw tool output or thinking content. Execution
is at-least-once, so irreversible tools still need their own idempotency.

## Conversations, naming, and history

Each Board Thread maps to a stable local binding. The first claimed task runs
`agy -p` without `--conversation`; the Bridge records the returned
`conversation_id`, and every later turn resumes that exact conversation, so the
agent keeps the CLI's real history and directory context. Web-created Threads
start empty and materialize on their first task.

The CLI has no public headless rename or transcript-read API, so:

- the Board UI hides Thread rename for Antigravity connections;
- deleting a Thread from the Web only removes the Bridge binding — the local
  agy conversation and its history stay on disk;
- pre-existing TUI conversations are not imported. Reading them would require
  decoding Google's private SQLite/protobuf storage, which is undocumented,
  fragile across CLI updates, and against Google's stated terms for third-party
  tools. Only runs the Bridge itself drives are synced.

## Web 会话图片

Web Console 的会话 turn 最多附带 4 张 PNG、JPEG、WebP 或 GIF（单张 10 MiB、
合计 20 MiB）。Antigravity headless 没有内联图片 flag，所以 Bridge 采用
官方支持的 workspace 文件读取路径：通过私有下载端点取回图片并校验字节数，
写入 Thread 工作目录下的临时目录 `.ai-task-board/turn-images/<task-id>/`
（文件名经过清洗，扩展名与 MIME 对齐），然后在 `agy -p` 的 prompt 中按绝对
路径要求 agent 先用文件读取工具读取这些图片。CLI 1.1.10 的媒体内联存在
崩溃缺陷，因此含图 turn 需要 Antigravity CLI 1.1.11+，版本不足时本轮会
失败并提示 `agy update`。

图片字节只在任务执行期间短暂落盘于受管工作目录，任务结束后即删除；只有
最终回复和受限元数据会上报看板。上传图片可能携带提示注入，prompt 会明确
指示 agent 将图片只当作视觉数据、不执行图中指令。最终是否读取由 agent
决定，必要时可在 Web 消息里写明“先查看附带的图片”。

Use `ai-task-board-bridge --help` for every environment variable.

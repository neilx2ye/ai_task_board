# AI Task Board Claude Code Bridge

This is the private Claude Code ACP runtime embedded in the public
`ai-task-board-bridge` tarball. It is not published as a second npm package.
The runtime connects AI Task Board to a real, authenticated Claude Code
installation through Anthropic's official
`@agentclientprotocol/claude-agent-acp` adapter and does not add Claude as a
fake Codex model.

One Bridge owns one Board AI Connection. It starts `claude-agent-acp`,
discovers Claude Code Sessions whose `cwd` exactly matches the local
allowlist, uploads the live Claude model catalog, claims work reserved for
each Session, and returns the final AI reply to the matching Board
conversation. Claude subscription and API usage do not expose a public local
quota endpoint, so this runtime intentionally does not report a quota
snapshot to the Board.

## Requirements

- Node.js 18 or newer
- `npm install -g @agentclientprotocol/claude-agent-acp`
- Claude Code authentication: a `claude login` for subscription users on the
  same OS user, or `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `CLAUDE_CODE_OAUTH_TOKEN` for API or custom-gateway users
- AI Task Board schema/API with Bridge inventory and Web Thread management
- A dedicated Board connection whose platform is `Claude Code`

## Linux setup

Run setup as the same OS user that owns the Claude login and target
workspaces:

```bash
npm install -g @agentclientprotocol/claude-agent-acp
npx --yes ai-task-board-bridge@1.8.4 setup claude
```

The wizard asks only for the Board URL (leave it empty to use
`https://task.neilx.online`) and the hidden Connection Token. Working
directories default to Web-side management, leaving the directory list to the
Board's "AI 连接 → Bridge 设置 / 新建项目"; passing
`CLAUDE_WORKING_DIRECTORY(S)` pins a local allowlist at install time instead.
With `AI_TASK_BOARD_CONNECTION_TOKEN` configured, `setup` runs
non-interactively even in a terminal. The installer writes a `0600`
environment file, stages the CLI and its ACP SDK dependency under the user's
XDG data directory, and starts `ai-task-board-claude-bridge.service` in that
user's systemd manager. It never puts the Board token on the command line.

API-credential environment variables present during setup
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) are
copied into the service environment file so the Bridge keeps authenticating
after the shell exits. Subscription users authenticate through the native
Claude credential store instead and do not need environment credentials.

The same service can be installed from an SSH command or CI script without a
terminal. Without `CLAUDE_WORKING_DIRECTORY(S)` the non-interactive install
also defaults to Web directory management; pass either variable to pin a
local allowlist instead. `AI_TASK_BOARD_URL` is optional and defaults to
`https://task.neilx.online`:

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CLAUDE_WORKING_DIRECTORY='/absolute/path/to/project' \
npx --yes ai-task-board-bridge@1.8.4 setup claude
```

## Foreground mode

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CLAUDE_WORKING_DIRECTORY='/absolute/path/to/project' \
CLAUDE_BRIDGE_MODE='default' \
CLAUDE_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.8.4 run claude
```

For several projects, set a stable exact-directory allowlist:

```bash
CLAUDE_WORKING_DIRECTORIES='[{"key":"app","name":"Main App","path":"/srv/app"},{"key":"docs","name":"Docs","path":"/srv/docs"}]'
```

The list accepts 1 to 100 unique `{key,name?,path}` objects. Web creation
sends only a stable directory key; the Bridge resolves it against this local
list, so a command cannot inject an arbitrary device path.

## Remote Web configuration

The Board UI is the sole configuration entry point; the Workspace Owner can
apply the Bridge settings without any device-side opt-in:

- enable/pause the Bridge (paused workers keep heartbeats but claim no new
  turns, and Web Thread creation is rejected);
- change the Session cap and device-wide concurrent-turn cap;
- toggle session-title upload; it is enabled by default for new connections,
  and `CLAUDE_BRIDGE_INCLUDE_SESSION_TITLES` is only a startup fallback;
- replace the effective working-directory list.

`CLAUDE_MAX_THREADS` is a startup fallback only. With Web configuration enabled
the Board owns the live 1..500 Session limit and 1..32 turn limit; neither is
clamped to the local environment value.
Claude Code does not implement thread-history import, so that Codex-specific
control is hidden.

A Board-provided list must contain 1 to 100 unique entries with absolute paths
that already exist and are directories; an entry may carry
`create_if_missing: true` to authorize the device to create the path with
`mkdir -p` first. The applied list replaces the effective allowlist at
runtime: the next inventory sync re-attributes Sessions to the new
directories, Sessions outside it are retired, and Web Thread creation
resolves `directory_key` against it. A null remote list restores the immutable
`CLAUDE_WORKING_DIRECTORIES` startup list.

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
rerunning `npx --yes ai-task-board-bridge@1.8.4 setup claude`.

With the systemd requirement satisfied, the Bridge downloads
`ai-task-board-bridge@<version>`, installs the embedded Claude Code runtime
into `versions/<version>/` next to the current one, smoke-tests
`node versions/<version>/dist/cli.js --version`, rewrites the systemd unit
`ExecStart` to the new runtime (preserving the existing `HOME`,
`WorkingDirectory`, and `EnvironmentFile` settings), runs
`systemctl --user daemon-reload`, and exits with code 75 so
`Restart=on-failure` starts the new version about five seconds later.

A failed attempt cleans up staging, keeps the old version running, and
reports the error in the next configuration exchange's `error` field, which
the Board surfaces in the Bridge settings dialog. The same target is not
retried for five minutes, absorbing npm-mirror synchronization lag and
transient network failures without turning a broken release into a retry
storm. Downloads default to the official `https://registry.npmjs.org`; set
`AI_TASK_BOARD_NPM_REGISTRY` to use a mirror instead.

Old version directories are kept for manual rollback. To roll back, point the
unit's `ExecStart` back at the previous runtime and restart the service:

```bash
$EDITOR ~/.config/systemd/user/ai-task-board-claude-bridge.service
# ExecStart="…/node" "…/.local/share/ai-task-board/claude-bridge/versions/<previous>/dist/cli.js" "run"
systemctl --user daemon-reload
systemctl --user restart ai-task-board-claude-bridge.service
```

## Execution and safety

`CLAUDE_BRIDGE_MODE` maps directly to Claude Code permission modes:
`default`, `plan`, `accept-edits`, or `bypass-permissions`.
`bypass-permissions` skips most permission checks and is high risk. Foreground
mode defaults `CLAUDE_BRIDGE_APPROVAL_MODE` to `accept`, which selects an ACP
`allow_once` choice only for a permission request correlated with an actively
claimed Board task. Uncorrelated requests are rejected. Interactive setup
defaults to `decline` and requires an explicit choice.

The Board token is removed from the `claude-agent-acp` child environment.
This is defense in depth, not isolation from other processes running as the
same OS user. Use a dedicated UID or token proxy when stronger isolation is
required.

The Bridge reports only the final assistant message plus bounded completion
metadata. It observes thought/tool/plan updates for counts but does not
upload their raw content. Execution is at-least-once, so irreversible tools
still need their own idempotency.

ACP supports creating, resuming, and deleting Claude Code Sessions. Claude
Code does not expose a reliable ACP rename operation, so the Board UI
intentionally hides rename for Claude Code connections. The requested name
for a Web-created Session remains the Board display name.

Goal mode maps to Claude Code's native session-scoped `/goal` command: turning
it on sets the task text as the goal before the turn, and turning it off sends
`/goal clear`. This requires a recent `claude-agent-acp` adapter that
advertises the ACP goal extension; older adapters fail the task with a clear
error instead of silently ignoring the request.

Use `ai-task-board-bridge --help` for every environment variable.

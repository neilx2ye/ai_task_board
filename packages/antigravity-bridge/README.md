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
  upgrade; `agy` logs in on first interactive run)
- AI Task Board schema/API with Bridge inventory and Web Thread management
- A dedicated Board connection whose platform is `Antigravity`

## Linux setup

Run setup as the same OS user that owns the Antigravity login and target
workspaces:

```bash
npx --yes ai-task-board-bridge@1.0.1 setup antigravity
```

The installer writes a `0600` environment file, stages the runtime under the
user's XDG data directory, and starts
`ai-task-board-antigravity-bridge.service` in that user's systemd manager. It
never puts the Board token on the command line.

## Foreground mode

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
ANTIGRAVITY_WORKING_DIRECTORY='/absolute/path/to/project' \
ANTIGRAVITY_BRIDGE_MODE='auto' \
ANTIGRAVITY_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.0.1 run antigravity
```

For several projects, set a stable exact-directory allowlist:

```bash
ANTIGRAVITY_WORKING_DIRECTORIES='[{"key":"app","name":"Main App","path":"/srv/app"},{"key":"docs","name":"Docs","path":"/srv/docs"}]'
```

The list accepts 1 to 100 unique `{key,name?,path}` objects. Web creation sends
only a stable directory key; the Bridge resolves it against this local list, so
a command cannot inject an arbitrary device path.

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

Use `ai-task-board-bridge --help` for every environment variable.

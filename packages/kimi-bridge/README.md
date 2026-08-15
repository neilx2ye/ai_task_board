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
npx --yes ai-task-board-bridge@1.1.0 setup kimi
```

The installer writes a `0600` environment file, stages the CLI and its ACP SDK
dependency under the user's XDG data directory, and starts
`ai-task-board-kimi-bridge.service` in that user's systemd manager. It never
puts the Board token on the command line.

## Foreground mode

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
KIMI_WORKING_DIRECTORY='/absolute/path/to/project' \
KIMI_BRIDGE_MODE='auto' \
KIMI_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.1.0 run kimi
```

For several projects, set a stable exact-directory allowlist:

```bash
KIMI_WORKING_DIRECTORIES='[{"key":"app","name":"Main App","path":"/srv/app"},{"key":"docs","name":"Docs","path":"/srv/docs"}]'
```

The list accepts 1 to 100 unique `{key,name?,path}` objects. Web creation sends
only a stable directory key; the Bridge resolves it against this local list, so
a command cannot inject an arbitrary device path.

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

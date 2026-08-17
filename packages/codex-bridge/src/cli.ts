#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const HELP = `AI Task Board Bridge

Usage:
  ai-task-board-bridge setup [codex|kimi|antigravity|both|all]
  ai-task-board-bridge run [codex|kimi|antigravity]
  ai-task-board-bridge

Commands:
  setup  Interactively choose and install Codex, Kimi, Antigravity, or several
         With no TTY, setup installs the systemd service from environment
         variables instead of prompting (Codex, Kimi, or Antigravity).
  run    Run one Bridge in the foreground using environment variables
         (default: codex)

With no command, an interactive terminal opens the unified installer when required
configuration is missing. Existing Codex environment launches remain compatible.
On Linux, setup always installs and starts the current user's systemd service or
services; it does not leave a Bridge running inside the npx process.

Examples:
  ai-task-board-bridge setup
  ai-task-board-bridge setup kimi
  ai-task-board-bridge setup antigravity
  ai-task-board-bridge setup both
  ai-task-board-bridge setup all
  ai-task-board-bridge run kimi
  ai-task-board-bridge run antigravity

Non-interactive Codex setup (service is installed and started by systemd):
  AI_TASK_BOARD_URL='https://board.example.com' \
  AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
  ai-task-board-bridge setup codex
Working directories are left to the Board's Web console by default; pass
CODEX_WORKING_DIRECTORY or CODEX_WORKING_DIRECTORIES to fix a local allowlist.

Required environment variables:
  AI_TASK_BOARD_URL               Board HTTPS base URL
  AI_TASK_BOARD_CONNECTION_TOKEN  AI Connection token created in the Board

Optional environment variables:
  CODEX_THREAD_ID                 Manage only this thread (legacy compatibility)
  CODEX_WORKING_DIRECTORY         Legacy single working directory (default: cwd)
  CODEX_WORKING_DIRECTORIES       JSON allowlist of {key,name,path} directories
  CODEX_THREAD_SCOPE              cwd (default, exact cwd) or all (high risk)
  CODEX_SESSION_NAME              Prefix for session names shown in the Board
  CODEX_BRIDGE_INCLUDE_THREAD_TITLES  true uploads local thread title/preview
  CODEX_BRIDGE_WEB_CONFIG          true lets the Board adjust gated runtime settings
  CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES  true lets Web enable title upload
  CODEX_BRIDGE_ALLOW_HISTORY_SYNC  true lets Web enable bounded history upload
  CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES  true lets Web replace the directory list
  CODEX_BRIDGE_MAX_HISTORY_TURNS   Local history limit ceiling (1..200, default: 50)
  CODEX_MODEL                     Informational model label
  CODEX_CAPABILITIES              Comma/space-separated capabilities
  CODEX_MAX_THREADS               Maximum top-level threads to manage (1..500)
  CODEX_MAX_CONCURRENT_TURNS      Legacy startup concurrency before Web applies (1..32, default: 2)
  CODEX_BRIDGE_APPROVAL_MODE      accept (default), decline, or accept-session; accept is automatic
  CODEX_BRIDGE_PERMISSION_MODE    danger-full-access (default), safe, or inherit; full/inherit may be high risk
  CODEX_HOME                      Codex config/data directory (default: current user's ~/.codex)
  CODEX_BINARY                    Codex executable (default: codex)
  AI_TASK_BOARD_POLL_INTERVAL_MS  Poll interval when SSE is unavailable (500..60000)
  AI_TASK_BOARD_LEASE_SECONDS     Task lease duration (60..3600, default: 900)
  AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS  Full inventory interval (10000..600000)
  AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS  Web config interval (1000..600000)

Kimi variables:
  KIMI_WORKING_DIRECTORY          Working directory (default: cwd)
  KIMI_WORKING_DIRECTORIES        JSON allowlist of {key,name,path} directories
  KIMI_MAX_THREADS                Maximum Sessions to manage (1..500)
  KIMI_MAX_CONCURRENT_TURNS       Device-wide concurrent turns (1..32)
  KIMI_BRIDGE_APPROVAL_MODE       accept or decline
  KIMI_BRIDGE_MODE                auto, default, plan, or yolo
  KIMI_BINARY                     Kimi Code executable (default: kimi)

Antigravity variables:
  ANTIGRAVITY_WORKING_DIRECTORY   Working directory (default: cwd)
  ANTIGRAVITY_WORKING_DIRECTORIES JSON allowlist of {key,name,path} directories
  ANTIGRAVITY_MAX_THREADS         Maximum Threads to manage (1..500)
  ANTIGRAVITY_MAX_CONCURRENT_TURNS Device-wide concurrent turns (1..32)
  ANTIGRAVITY_BRIDGE_APPROVAL_MODE accept or decline
  ANTIGRAVITY_BRIDGE_MODE         auto, default, accept-edits, or plan
  ANTIGRAVITY_BRIDGE_SANDBOX      true enables agy terminal sandbox
  ANTIGRAVITY_PRINT_TIMEOUT       Go duration, e.g. 5m, 90s, or 1h
  ANTIGRAVITY_BINARY              Antigravity CLI executable (default: agy)

Options:
  -h, --help     Show this help
  -v, --version  Show the package version
`;

async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }
  if (args[0] === "setup") {
    const {
      parseBridgeSetupTarget,
      promptForBridgeSetupTarget,
      runBridgeSetup,
    } = await import("./installer.js");
    if (args.length > 2) {
      process.stderr.write(`Unknown option: ${args[2]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    const requestedTarget = parseBridgeSetupTarget(args[1]);
    if (args[1] && !requestedTarget) {
      process.stderr.write(`Unknown setup target: ${args[1]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    const target = requestedTarget ?? (await promptForBridgeSetupTarget());
    const execution =
      process.stdin.isTTY && process.stdout.isTTY
        ? "interactive"
        : "noninteractive";
    await runBridgeSetup(target, await packageVersion(), execution);
    return;
  }
  if (args[0] === "run") {
    const { parseBridgeRunTarget, runAgentBridge } = await import(
      "./installer.js"
    );
    if (args.length > 2) {
      process.stderr.write(`Unknown option: ${args[2]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    const target = args[1] ? parseBridgeRunTarget(args[1]) : "codex";
    if (!target) {
      process.stderr.write(`Unknown run target: ${args[1]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    await runAgentBridge(target);
    return;
  }
  if (args.length > 0) {
    process.stderr.write(`Unknown option: ${args[0]}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const missingRequiredConfiguration =
    !process.env.AI_TASK_BOARD_URL?.trim() ||
    !process.env.AI_TASK_BOARD_CONNECTION_TOKEN?.trim();
  if (
    missingRequiredConfiguration &&
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    const { promptForBridgeSetupTarget, runBridgeSetup } = await import(
      "./installer.js"
    );
    await runBridgeSetup(
      await promptForBridgeSetupTarget(),
      await packageVersion(),
    );
    return;
  }

  const { runAgentBridge } = await import("./installer.js");
  await runAgentBridge("codex");
}

void run().catch((error) => {
  process.stderr.write(`Bridge 操作失败：${String(error)}\n`);
  process.exitCode = 1;
});

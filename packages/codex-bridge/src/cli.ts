#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const HELP = `AI Task Board Codex Bridge

Usage:
  ai-task-board-codex-bridge

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
  CODEX_BRIDGE_APPROVAL_MODE      accept (default), decline, or accept-session
  CODEX_BRIDGE_PERMISSION_MODE    safe (default) or inherit (high risk)
  CODEX_BINARY                    Codex executable (default: codex)
  AI_TASK_BOARD_POLL_INTERVAL_MS  Poll interval when SSE is unavailable (500..60000)
  AI_TASK_BOARD_LEASE_SECONDS     Task lease duration (60..3600, default: 900)
  AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS  Full inventory interval (10000..600000)
  AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS  Web config interval (1000..600000)

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
  if (args.length > 0) {
    process.stderr.write(`Unknown option: ${args[0]}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const { runBridgeCli } = await import("./bridge.js");
  await runBridgeCli();
}

void run().catch((error) => {
  process.stderr.write(`Codex Bridge 启动失败：${String(error)}\n`);
  process.exitCode = 1;
});

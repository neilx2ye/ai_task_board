#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const HELP = `AI Task Board Kimi Bridge Runtime

Usage:
  ai-task-board-bridge setup kimi
  ai-task-board-bridge run kimi

This private runtime is embedded in the public ai-task-board-bridge package.
Its direct "run" entry is used only by the installed systemd service.

Commands:
  setup  Interactively configure and install a systemd user service on Linux
  run    Run the Kimi Bridge using environment variables

Required environment variables:
  AI_TASK_BOARD_URL               Board HTTPS base URL
  AI_TASK_BOARD_CONNECTION_TOKEN  Kimi Code AI Connection token

Optional environment variables:
  KIMI_WORKING_DIRECTORY          Legacy single working directory (default: cwd);
                                  omit at setup to manage directories from the Web
  KIMI_WORKING_DIRECTORIES        JSON allowlist of {key,name,path} directories
  KIMI_SESSION_NAME               Prefix for names shown in the Board
  KIMI_BRIDGE_INCLUDE_SESSION_TITLES  true uploads local Kimi session titles
  KIMI_BRIDGE_ALLOW_REMOTE_THREAD_TITLES  true lets Web enable title upload
  KIMI_BRIDGE_WEB_CONFIG          true lets Web apply enabled/limits/titles
  KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION  true lets Web replace the
                                  working directory list (written by setup when
                                  Web directory management is chosen)
  KIMI_CAPABILITIES               Comma/space-separated Board capabilities
  KIMI_MAX_THREADS                Local Session ceiling (1..500, default: 50)
  KIMI_MAX_CONCURRENT_TURNS       Startup concurrency (1..32, default: 2)
  KIMI_BRIDGE_APPROVAL_MODE       accept (default) or decline
  KIMI_BRIDGE_MODE                auto (default), default, plan, or yolo
  KIMI_BINARY                     Kimi Code executable (default: kimi)
  AI_TASK_BOARD_POLL_INTERVAL_MS  Task poll interval (500..60000)
  AI_TASK_BOARD_LEASE_SECONDS     Task lease duration (60..3600, default: 900)
  AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS  Inventory interval (10000..600000)
  AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS  Command poll interval (1000..600000)

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
  if (args.length === 1 && args[0] === "setup") {
    const { runInteractiveSetup } = await import("./setup.js");
    await runInteractiveSetup({ packageVersion: await packageVersion() });
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "run")) {
    process.stderr.write(`Unknown option: ${args[0]}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  const explicitRun = args[0] === "run";
  const missingConfiguration =
    !process.env.AI_TASK_BOARD_URL?.trim() ||
    !process.env.AI_TASK_BOARD_CONNECTION_TOKEN?.trim();
  if (
    !explicitRun &&
    missingConfiguration &&
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    const { runInteractiveSetup } = await import("./setup.js");
    await runInteractiveSetup({ packageVersion: await packageVersion() });
    return;
  }

  const { runBridgeCli } = await import("./bridge.js");
  await runBridgeCli();
}

void run().catch((error) => {
  process.stderr.write(`Kimi Bridge 操作失败：${String(error)}\n`);
  process.exitCode = 1;
});

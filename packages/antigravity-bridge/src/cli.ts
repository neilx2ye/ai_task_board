#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const DEFAULT_BOARD_URL = "https://task.neilx.online";

const HELP = `AI Task Board Antigravity Bridge Runtime

Usage:
  ai-task-board-bridge setup antigravity
  ai-task-board-bridge run antigravity

This private runtime is embedded in the public ai-task-board-bridge package.
Its direct "run" entry is used only by the installed systemd service.

Commands:
  setup  Interactively configure and install a systemd user service on Linux
  run    Run the Antigravity Bridge in the foreground using environment variables

Interactive vs non-interactive:
  未提供 AI_TASK_BOARD_CONNECTION_TOKEN 时进入交互式配置，只询问 Board 地址
  （留空使用 ${DEFAULT_BOARD_URL}）与 Connection Token；其余配置在网页
  「AI 连接 → Bridge 设置」中管理。提供 Token 后直接按环境变量非交互运行。

Required environment variables:
  AI_TASK_BOARD_CONNECTION_TOKEN  Antigravity AI Connection token

Optional environment variables:
  AI_TASK_BOARD_URL               Board HTTPS base URL (default: ${DEFAULT_BOARD_URL})
  ANTIGRAVITY_WORKING_DIRECTORY   Legacy single working directory (default: cwd)
  ANTIGRAVITY_WORKING_DIRECTORIES JSON allowlist of {key,name,path} directories
  ANTIGRAVITY_SESSION_NAME        Prefix for names shown in the Board
  ANTIGRAVITY_CAPABILITIES        Comma/space-separated Board capabilities
  ANTIGRAVITY_BRIDGE_WEB_CONFIG   Deprecated: Web configuration is always enabled
  ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION  Deprecated: Web always
                                  owns the working directory list
  ANTIGRAVITY_MAX_THREADS         Startup Thread fallback (1..500, default: 50)
  ANTIGRAVITY_MAX_CONCURRENT_TURNS Startup concurrency (1..32, default: 5)
  ANTIGRAVITY_BRIDGE_APPROVAL_MODE accept or decline
  ANTIGRAVITY_BRIDGE_MODE         auto, default, accept-edits, or plan
  ANTIGRAVITY_BRIDGE_SANDBOX      true enables agy terminal sandbox
  ANTIGRAVITY_PRINT_TIMEOUT       Go duration, e.g. 5m, 90s, or 1h
  ANTIGRAVITY_REGISTRY_FILE       Local thread registry JSON path
  ANTIGRAVITY_BINARY              Antigravity CLI executable (default: agy)

Options:
  -h, --help     Show this help
  -v, --version  Show the package version
`;

async function packageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

function hasConnectionEnvironment(): boolean {
  return Boolean(process.env.AI_TASK_BOARD_CONNECTION_TOKEN?.trim());
}

function applyDefaultBoardUrl(): void {
  if (!process.env.AI_TASK_BOARD_URL?.trim()) {
    process.env.AI_TASK_BOARD_URL = DEFAULT_BOARD_URL;
  }
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

  const command = args[0];
  if (command === "setup") {
    if (
      args.length > 2 ||
      (args[1] && args[1] !== "antigravity" && args[1] !== "agy")
    ) {
      process.stderr.write(`Unknown setup target: ${args[1] ?? args[2]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    applyDefaultBoardUrl();
    if (hasConnectionEnvironment()) {
      const { runAntigravityNonInteractiveSetup } = await import("./setup.js");
      await runAntigravityNonInteractiveSetup({
        packageVersion: await packageVersion(),
      });
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "setup 需要交互式终端；非交互安装请提供 AI_TASK_BOARD_CONNECTION_TOKEN 环境变量",
      );
    }
    const { runInteractiveSetup } = await import("./setup.js");
    await runInteractiveSetup({ packageVersion: await packageVersion() });
    return;
  }

  if (command === "run") {
    if (
      args.length > 2 ||
      (args[1] && args[1] !== "antigravity" && args[1] !== "agy")
    ) {
      process.stderr.write(`Unknown run target: ${args[1] ?? args[2]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    applyDefaultBoardUrl();
    const { runBridgeCli } = await import("./bridge.js");
    await runBridgeCli();
    return;
  }

  if (args.length > 0) {
    process.stderr.write(`Unknown option: ${args[0]}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  // Legacy bare invocation.
  applyDefaultBoardUrl();
  if (!hasConnectionEnvironment() && process.stdin.isTTY && process.stdout.isTTY) {
    const { runInteractiveSetup } = await import("./setup.js");
    await runInteractiveSetup({ packageVersion: await packageVersion() });
    return;
  }
  const { runBridgeCli } = await import("./bridge.js");
  await runBridgeCli();
}

void run().catch((error) => {
  process.stderr.write(`Antigravity Bridge 操作失败：${String(error)}\n`);
  process.exitCode = 1;
});

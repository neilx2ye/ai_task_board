#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const DEFAULT_BOARD_URL = "https://task.neilx.online";

const HELP = `AI Task Board Kimi Bridge Runtime

Usage:
  ai-task-board-bridge setup kimi
  ai-task-board-bridge run kimi

This private runtime is embedded in the public ai-task-board-bridge package.
Its direct "run" entry is used only by the installed systemd service.

Commands:
  setup  Interactively configure and install a systemd user service on Linux
  run    Run the Kimi Bridge in the foreground using environment variables

Interactive vs non-interactive:
  未提供 AI_TASK_BOARD_CONNECTION_TOKEN 时进入交互式配置，只询问 Board 地址
  （留空使用 ${DEFAULT_BOARD_URL}）与 Connection Token；其余配置在网页
  「AI 连接 → Bridge 设置」中管理。提供 Token 后直接按环境变量非交互运行。

Required environment variables:
  AI_TASK_BOARD_CONNECTION_TOKEN  Kimi Code AI Connection token

Optional environment variables:
  AI_TASK_BOARD_URL               Board HTTPS base URL (default: ${DEFAULT_BOARD_URL})
  KIMI_WORKING_DIRECTORY          Legacy single working directory (default: cwd);
                                  omit at setup to manage directories from the Web
  KIMI_WORKING_DIRECTORIES        JSON allowlist of {key,name,path} directories
  KIMI_SESSION_NAME               Prefix for names shown in the Board
  KIMI_BRIDGE_INCLUDE_SESSION_TITLES  true uploads local Kimi session titles
  KIMI_BRIDGE_ALLOW_REMOTE_THREAD_TITLES  true lets Web enable title upload
  KIMI_BRIDGE_WEB_CONFIG          true lets Web apply enabled/limits/titles
  KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION  true lets Web replace the
                                  working directory list
  KIMI_CAPABILITIES               Comma/space-separated Board capabilities
  KIMI_MAX_THREADS                Local Session ceiling (1..500, default: 50)
  KIMI_MAX_CONCURRENT_TURNS       Startup concurrency (1..32, default: 2)
  KIMI_BRIDGE_APPROVAL_MODE       accept or decline
  KIMI_BRIDGE_MODE                auto, default, plan, or yolo
  KIMI_BINARY                     Kimi Code executable (default: kimi)

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
    if (args.length > 2 || (args[1] && args[1] !== "kimi" && args[1] !== "kimi-code")) {
      process.stderr.write(`Unknown setup target: ${args[1] ?? args[2]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    applyDefaultBoardUrl();
    if (hasConnectionEnvironment()) {
      const { runKimiNonInteractiveSetup } = await import("./setup.js");
      await runKimiNonInteractiveSetup({
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
    if (args.length > 2 || (args[1] && args[1] !== "kimi" && args[1] !== "kimi-code")) {
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
  process.stderr.write(`Kimi Bridge 操作失败：${String(error)}\n`);
  process.exitCode = 1;
});

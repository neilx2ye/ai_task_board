#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
  applyDefaultBoardUrl,
  hasConnectionEnvironment,
} from "./interactive.js";
import {
  parseBridgeRunTarget,
  parseBridgeSetupTarget,
  promptForBridgeRunTarget,
  promptForBridgeSetupTarget,
  runAgentBridge,
  runAgentBridgeConfigured,
  runBridgeSetup,
} from "./installer.js";

const HELP = `AI Task Board Bridge

Usage:
  ai-task-board-bridge setup [codex|kimi|antigravity|both|all]
  ai-task-board-bridge run [codex|kimi|antigravity]

Commands:
  setup  Interactively choose and install Codex, Kimi, Antigravity, or several.
         On Linux, setup installs and starts the current user's systemd service
         or services; it does not leave a Bridge running inside the npx process.
  run    Run one Bridge in the foreground using environment variables
         (default: codex)

Interactive vs non-interactive:
  未提供 AI_TASK_BOARD_CONNECTION_TOKEN 时进入交互式配置：先询问要安装/运行的
  Bridge（已通过参数指定则跳过），再询问 Board 地址（留空使用
  https://task.neilx.online）与 Connection Token。三种 Bridge 的交互问题完全
  一致，其余配置（工作目录、thread/并发上限、权限与审批策略等）在网页
  「AI 连接 → Bridge 设置」中管理。
  提供 AI_TASK_BOARD_CONNECTION_TOKEN 后直接按环境变量非交互安装/运行，不再
  提问；未提供 Board 地址时同样使用默认地址。run 直接前台运行，npx 进程结束后
  Bridge 随之下线；setup 写入当前用户的 systemd 用户服务并立即启动。

Examples:
  ai-task-board-bridge setup
  ai-task-board-bridge setup kimi
  ai-task-board-bridge run antigravity
  AI_TASK_BOARD_URL='https://board.example.com' \\
    AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
    ai-task-board-bridge setup codex

Required environment variables:
  AI_TASK_BOARD_CONNECTION_TOKEN  AI Connection token created in the Board

Optional environment variables:
  AI_TASK_BOARD_URL               Board HTTPS base URL (default: https://task.neilx.online)
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
  const option = args[1];

  if (command === "setup") {
    if (args.length > 2) {
      process.stderr.write(`Unknown option: ${args[2]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    let target = parseBridgeSetupTarget(option);
    if (option && !target) {
      process.stderr.write(`Unknown setup target: ${option}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    if (!target) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "setup 需要交互式终端；未指定 Bridge 类型。请运行 ai-task-board-bridge setup codex|kimi|antigravity|both|all",
        );
      }
      target = await promptForBridgeSetupTarget();
    }
    await runBridgeSetup(target, await packageVersion());
    return;
  }

  if (command === "run") {
    if (args.length > 2) {
      process.stderr.write(`Unknown option: ${args[2]}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    let target = parseBridgeRunTarget(option);
    if (option && !target) {
      process.stderr.write(`Unknown run target: ${option}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    if (!target) {
      target =
        process.stdin.isTTY && process.stdout.isTTY
          ? await promptForBridgeRunTarget()
          : "codex";
    }
    await runAgentBridgeConfigured(target);
    return;
  }

  if (args.length > 0) {
    process.stderr.write(`Unknown option: ${args[0]}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  // Legacy bare invocation: foreground Codex when configured, otherwise the
  // interactive installer. New deployments should use setup/run explicitly.
  applyDefaultBoardUrl();
  if (hasConnectionEnvironment(process.env)) {
    await runAgentBridge("codex");
    return;
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runBridgeSetup(await promptForBridgeSetupTarget(), await packageVersion());
    return;
  }
  throw new Error(
    "缺少 AI_TASK_BOARD_CONNECTION_TOKEN；请运行 ai-task-board-bridge setup 交互安装，或通过 AI_TASK_BOARD_URL / AI_TASK_BOARD_CONNECTION_TOKEN 环境变量启动",
  );
}

void run().catch((error) => {
  process.stderr.write(`Bridge 操作失败：${String(error)}\n`);
  process.exitCode = 1;
});

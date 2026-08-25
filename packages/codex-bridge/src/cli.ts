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
  ai-task-board-bridge setup [codex|kimi|antigravity|claude|both|all]
  ai-task-board-bridge run [codex|kimi|antigravity|claude|all]

Commands:
  setup  Interactively choose and install one unified device Bridge for the
         current user. A single service, environment file and Connection Token
         host Codex, Kimi, Antigravity and Claude Code together; re-running
         setup merges newly available Bridge kinds without re-asking the token.
  run    Run one Bridge runtime, or "run all" to run the unified supervisor,
         in the foreground using environment variables.

Interactive vs non-interactive:
  在交互式终端中，setup 每次都会重新询问 Board 地址（留空使用
  https://task.neilx.online）、Connection Token 与要启用的 Bridge 类型；
  Token 留空保留已保存的值，输入新值则替换（同一设备更换连接时无需改其他
  配置）。其余配置（工作目录、thread/并发上限、权限与审批策略等）统一写入
  同一份环境文件并覆盖 Codex、Kimi、Antigravity 与 Claude Code，网页
  「AI 连接 → Bridge 设置」按平台展示与调整。
  SSH / CI 等非交互环境读取 AI_TASK_BOARD_CONNECTION_TOKEN 或已保存的
  Token，不再提问；未提供 Board 地址时同样使用默认地址。run 直接前台运行，
  npx 进程结束后 Bridge 随之下线；setup 写入并启动当前用户的唯一 systemd
  用户服务（current user's systemd service）并立即启动。

Examples:
  ai-task-board-bridge setup
  ai-task-board-bridge setup kimi
  ai-task-board-bridge run all
  ai-task-board-bridge run antigravity
  ai-task-board-bridge setup claude
  AI_TASK_BOARD_URL='https://board.example.com' \\
    AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
    ai-task-board-bridge setup codex

Required environment variables:
  AI_TASK_BOARD_CONNECTION_TOKEN  AI Connection token created in the Board

Optional environment variables:
  AI_TASK_BOARD_URL               Board HTTPS base URL (default: https://task.neilx.online)
  AI_TASK_BOARD_BRIDGES           Comma list of enabled kinds for run all/setup
                                  (codex,kimi,antigravity,claude or all)
  CODEX_THREAD_ID                 Manage only this thread (legacy compatibility)
  CODEX_WORKING_DIRECTORY         Legacy single working directory (default: cwd)
  CODEX_WORKING_DIRECTORIES       JSON allowlist of {key,name,path} directories
  CODEX_THREAD_SCOPE              cwd (default, exact cwd) or all (high risk)
  CODEX_SESSION_NAME              Prefix for session names shown in the Board
  CODEX_BRIDGE_INCLUDE_THREAD_TITLES  true uploads local thread title/preview
  CODEX_BRIDGE_WEB_CONFIG          Deprecated: Web configuration is always enabled
  CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES  Deprecated: Web always owns title upload
  CODEX_BRIDGE_ALLOW_HISTORY_SYNC  Deprecated: Web always owns history sync
  CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES  Deprecated: Web always owns the directory list
  CODEX_BRIDGE_MAX_HISTORY_TURNS   Startup history fallback (1..500, default: 50)
  CODEX_MODEL                     Informational model label
  CODEX_CAPABILITIES              Comma/space-separated capabilities
  CODEX_MAX_THREADS               Startup thread fallback before Web applies (1..500)
  CODEX_MAX_CONCURRENT_TURNS      Legacy startup concurrency before Web applies (1..32, default: 5)
  CODEX_BRIDGE_APPROVAL_MODE      Startup fallback; Web can override (accept, decline, accept-session)
  CODEX_BRIDGE_PERMISSION_MODE    Startup fallback; Web can override (danger-full-access, safe, inherit)
  CODEX_HOME                      Codex config/data directory (default: current user's ~/.codex)
  CODEX_BINARY                    Codex executable (default: codex)
  AI_TASK_BOARD_POLL_INTERVAL_MS  Poll interval when SSE is unavailable (500..60000)
  AI_TASK_BOARD_LEASE_SECONDS     Task lease duration (60..3600, default: 900)
  AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS  Full inventory interval (10000..600000)
  AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS  Web config interval (1000..600000)
  AI_TASK_BOARD_NPM_REGISTRY     Self-update download registry (default: https://registry.npmjs.org)

Kimi variables:
  KIMI_WORKING_DIRECTORY          Working directory (default: cwd)
  KIMI_WORKING_DIRECTORIES        JSON allowlist of {key,name,path} directories
  KIMI_MAX_THREADS                Startup Session fallback before Web applies (1..500)
  KIMI_MAX_CONCURRENT_TURNS       Device-wide concurrent turns (1..32, default: 5)
  KIMI_BRIDGE_APPROVAL_MODE       accept or decline
  KIMI_BRIDGE_MODE                auto, default, plan, or yolo
  KIMI_BINARY                     Kimi Code executable (default: kimi)

Antigravity variables:
  ANTIGRAVITY_WORKING_DIRECTORY   Working directory (default: cwd)
  ANTIGRAVITY_WORKING_DIRECTORIES JSON allowlist of {key,name,path} directories
  ANTIGRAVITY_MAX_THREADS         Startup Thread fallback before Web applies (1..500)
  ANTIGRAVITY_MAX_CONCURRENT_TURNS Device-wide concurrent turns (1..32, default: 5)
  ANTIGRAVITY_BRIDGE_APPROVAL_MODE accept or decline
  ANTIGRAVITY_BRIDGE_MODE         auto, default, accept-edits, or plan
  ANTIGRAVITY_BRIDGE_SANDBOX      true enables agy terminal sandbox
  ANTIGRAVITY_PRINT_TIMEOUT       Go duration, e.g. 5m, 90s, or 1h
  ANTIGRAVITY_REGISTRY_FILE       Local thread registry JSON path
  ANTIGRAVITY_BINARY              Antigravity CLI executable (default: agy)

Claude variables:
  CLAUDE_WORKING_DIRECTORY        Working directory (default: cwd)
  CLAUDE_WORKING_DIRECTORIES      JSON allowlist of {key,name,path} directories
  CLAUDE_MAX_THREADS              Startup Session fallback before Web applies (1..500)
  CLAUDE_MAX_CONCURRENT_TURNS     Device-wide concurrent turns (1..32, default: 5)
  CLAUDE_BRIDGE_APPROVAL_MODE     accept or decline
  CLAUDE_BRIDGE_MODE              default, plan, accept-edits, or bypass-permissions
  CLAUDE_BINARY                   claude-agent-acp executable; setup installs it
                                  automatically when Claude Code is enabled

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
        // 非交互环境下未显式指定平台时，默认统一配置全部四种运行时；
        // Token 来自环境变量或已保存的安装配置。
        target = "all";
      } else {
        target = await promptForBridgeSetupTarget();
      }
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

import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";

import {
  applyDefaultBoardUrl,
  hasConnectionEnvironment,
  promptForConnectionBasics,
  TerminalPrompter,
} from "./interactive.js";
import {
  runUnifiedSupervisor,
  type UnifiedBridgeKind,
} from "./supervisor.js";
import { runUnifiedSetup } from "./unified-setup.js";

export type BridgeSetupTarget =
  | "codex"
  | "kimi"
  | "antigravity"
  | "claude"
  | "both"
  | "all";
export type BridgeRunTarget =
  | "codex"
  | "kimi"
  | "antigravity"
  | "claude"
  | "all";

export const BRIDGE_SETUP_CHOICES: ReadonlyArray<{
  value: BridgeSetupTarget;
  label: string;
}> = [
  { value: "codex", label: "Codex Bridge" },
  { value: "kimi", label: "Kimi Bridge（Kimi Code ACP）" },
  {
    value: "antigravity",
    label: "Antigravity Bridge（Google Antigravity CLI）",
  },
  {
    value: "claude",
    label: "Claude Code Bridge（claude-agent-acp）",
  },
  { value: "both", label: "Codex Bridge 和 Kimi Bridge" },
  {
    value: "all",
    label: "统一设备 Bridge（一个服务运行全部四种 Bridge）",
  },
];

const BRIDGE_RUN_CHOICES: ReadonlyArray<{
  value: BridgeRunTarget;
  label: string;
}> = [
  ...BRIDGE_SETUP_CHOICES.filter(
    (choice): choice is { value: BridgeRunTarget; label: string } =>
      choice.value !== "both",
  ),
];

export function parseBridgeSetupTarget(
  value: string | undefined,
): BridgeSetupTarget | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "codex") return "codex";
  if (normalized === "kimi" || normalized === "kimi-code") return "kimi";
  if (normalized === "antigravity" || normalized === "agy") {
    return "antigravity";
  }
  if (normalized === "claude" || normalized === "claude-code") {
    return "claude";
  }
  if (normalized === "both") return "both";
  if (normalized === "all") return "all";
  return null;
}

export function parseBridgeRunTarget(
  value: string | undefined,
): BridgeRunTarget | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "all" ||
    normalized === "supervisor" ||
    normalized === "supervise" ||
    normalized === "unified"
  ) {
    return "all";
  }
  const target = parseBridgeSetupTarget(value);
  return target === "codex" ||
    target === "kimi" ||
    target === "antigravity" ||
    target === "claude"
    ? target
    : null;
}

async function promptForTarget(
  choices: ReadonlyArray<{ value: string; label: string }>,
  fallback: string,
  header: string,
  input: ReadStream,
  output: WriteStream,
): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "setup 需要交互式终端；非交互安装请提供 AI_TASK_BOARD_CONNECTION_TOKEN 环境变量",
    );
  }

  const readline = createInterface({ input, output, terminal: true });
  try {
    output.write(`\nAI Task Board Bridge\n\n${header}\n`);
    choices.forEach((choice, index) => {
      output.write(`  ${index + 1}) ${choice.label}\n`);
    });

    while (true) {
      const answer = (await readline.question("请选择 [1]: "))
        .trim()
        .toLowerCase();
      if (!answer) return fallback;
      const numericChoice = Number(answer) - 1;
      if (Number.isInteger(numericChoice) && choices[numericChoice]) {
        return choices[numericChoice].value;
      }
      const namedChoice = choices.find((choice) => choice.value === answer);
      if (namedChoice) return namedChoice.value;
      output.write(
        `  请输入 1 到 ${choices.length}，或 ${choices
          .map((choice) => choice.value)
          .join("、")}。\n`,
      );
    }
  } finally {
    readline.close();
  }
}

export function promptForBridgeSetupTarget(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<BridgeSetupTarget> {
  return promptForTarget(
    BRIDGE_SETUP_CHOICES,
    "codex",
    "要安装什么？",
    input,
    output,
  ) as Promise<BridgeSetupTarget>;
}

export function promptForBridgeRunTarget(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<BridgeRunTarget> {
  return promptForTarget(
    BRIDGE_RUN_CHOICES,
    "all",
    "要运行哪个 Bridge？默认统一设备 Bridge 同时运行全部已启用类型。",
    input,
    output,
  ) as Promise<BridgeRunTarget>;
}

/**
 * Unified setup entrypoint. A single explicit target runs interactively only
 * when no Connection Token is configured; with a token it installs directly
 * from the environment. Every target installs the same single user service,
 * one environment file and one token; re-running a target merges the new
 * Bridge kinds into the existing install.
 */
export async function runBridgeSetup(
  target: BridgeSetupTarget,
  packageVersion: string,
): Promise<void> {
  applyDefaultBoardUrl();

  const interactive = !hasConnectionEnvironment(process.env);
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      "setup 需要交互式终端；非交互安装请提供 AI_TASK_BOARD_CONNECTION_TOKEN 环境变量",
    );
  }
  const targets: readonly UnifiedBridgeKind[] =
    target === "codex"
      ? ["codex"]
      : target === "kimi"
        ? ["kimi"]
        : target === "antigravity"
          ? ["antigravity"]
          : target === "claude"
            ? ["claude"]
            : target === "both"
              ? ["codex", "kimi"]
              : ["codex", "kimi", "antigravity", "claude"];
  await runUnifiedSetup({ packageVersion, targets }, interactive);
}

/**
 * Run a Bridge in the foreground. With a Connection Token configured the
 * process starts immediately; without one and with a terminal attached it
 * asks the same minimal questions as setup, then starts in the foreground.
 */
export async function runAgentBridgeConfigured(
  target: BridgeRunTarget,
): Promise<void> {
  applyDefaultBoardUrl();
  if (!hasConnectionEnvironment(process.env)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "缺少 AI_TASK_BOARD_CONNECTION_TOKEN；请通过环境变量提供，或在交互式终端中运行以输入 Board 地址与 Token",
      );
    }
    const prompt = new TerminalPrompter(process.stdin, process.stdout);
    try {
      const basics = await promptForConnectionBasics(prompt, {
        environment: process.env,
      });
      process.env.AI_TASK_BOARD_URL = basics.boardUrl;
      process.env.AI_TASK_BOARD_CONNECTION_TOKEN = basics.connectionToken;
    } finally {
      prompt.close();
    }
  }
  await runAgentBridge(target);
}

export async function runAgentBridge(target: BridgeRunTarget): Promise<void> {
  if (target === "all") {
    await runUnifiedSupervisor();
    return;
  }

  if (target === "codex") {
    const { runBridgeCli } = await import("./bridge.js");
    await runBridgeCli();
    return;
  }

  if (target === "kimi") {
    const runtimeModule = "./kimi-runtime/index.js";
    const { runKimiBridgeCli } = (await import(runtimeModule)) as {
      runKimiBridgeCli: () => Promise<void>;
    };
    await runKimiBridgeCli();
    return;
  }

  if (target === "antigravity") {
    const runtimeModule = "./antigravity-runtime/index.js";
    const { runAntigravityBridgeCli } = (await import(runtimeModule)) as {
      runAntigravityBridgeCli: () => Promise<void>;
    };
    await runAntigravityBridgeCli();
    return;
  }

  const runtimeModule = "./claude-runtime/index.js";
  const { runClaudeBridgeCli } = (await import(runtimeModule)) as {
    runClaudeBridgeCli: () => Promise<void>;
  };
  await runClaudeBridgeCli();
}

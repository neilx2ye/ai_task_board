import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";

import {
  applyDefaultBoardUrl,
  hasConnectionEnvironment,
  promptForConnectionBasics,
  TerminalPrompter,
} from "./interactive.js";

export type BridgeSetupTarget =
  | "codex"
  | "kimi"
  | "antigravity"
  | "both"
  | "all";
export type BridgeRunTarget = Exclude<BridgeSetupTarget, "both" | "all">;

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
  { value: "both", label: "Codex Bridge 和 Kimi Bridge" },
  { value: "all", label: "Codex、Kimi 和 Antigravity Bridge" },
];

const BRIDGE_RUN_CHOICES = BRIDGE_SETUP_CHOICES.filter(
  (choice): choice is { value: BridgeRunTarget; label: string } =>
    choice.value !== "both" && choice.value !== "all",
);

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
  if (normalized === "both") return "both";
  if (normalized === "all") return "all";
  return null;
}

export function parseBridgeRunTarget(
  value: string | undefined,
): BridgeRunTarget | null {
  const target = parseBridgeSetupTarget(value);
  return target === "codex" ||
    target === "kimi" ||
    target === "antigravity"
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
    "codex",
    "要运行哪个 Bridge？",
    input,
    output,
  ) as Promise<BridgeRunTarget>;
}

type InteractiveSetupRunner = (options: {
  packageVersion: string;
}) => Promise<void>;

async function setupCodexInteractive(
  packageVersion: string,
): Promise<void> {
  const { runInteractiveSetup } = await import("./setup.js");
  await runInteractiveSetup({ packageVersion });
}

async function setupCodexNonInteractive(
  packageVersion: string,
): Promise<void> {
  const { runNonInteractiveSetup } = await import("./setup.js");
  await runNonInteractiveSetup({ packageVersion });
}

async function setupKimi(
  packageVersion: string,
  interactive: boolean,
): Promise<void> {
  const runtimeModule = "./kimi-runtime/index.js";
  const { runKimiInteractiveSetup, runKimiNonInteractiveSetup } =
    (await import(runtimeModule)) as {
      runKimiInteractiveSetup: InteractiveSetupRunner;
      runKimiNonInteractiveSetup: InteractiveSetupRunner;
    };
  if (interactive) {
    await runKimiInteractiveSetup({ packageVersion });
    return;
  }
  await runKimiNonInteractiveSetup({ packageVersion });
}

async function setupAntigravity(
  packageVersion: string,
  interactive: boolean,
): Promise<void> {
  const runtimeModule = "./antigravity-runtime/index.js";
  const { runAntigravityInteractiveSetup, runAntigravityNonInteractiveSetup } =
    (await import(runtimeModule)) as {
      runAntigravityInteractiveSetup: InteractiveSetupRunner;
      runAntigravityNonInteractiveSetup: InteractiveSetupRunner;
    };
  if (interactive) {
    await runAntigravityInteractiveSetup({ packageVersion });
    return;
  }
  await runAntigravityNonInteractiveSetup({ packageVersion });
}

async function runSingleTargetSetup(
  target: BridgeRunTarget,
  packageVersion: string,
  interactive: boolean,
): Promise<void> {
  if (target === "codex") {
    if (interactive) {
      await setupCodexInteractive(packageVersion);
    } else {
      await setupCodexNonInteractive(packageVersion);
    }
    return;
  }
  if (target === "kimi") {
    await setupKimi(packageVersion, interactive);
    return;
  }
  await setupAntigravity(packageVersion, interactive);
}

/**
 * Unified setup entrypoint. A single explicit target runs interactively only
 * when no Connection Token is configured; with a token it installs directly
 * from the environment. both/all always run interactively because each
 * platform has its own token.
 */
export async function runBridgeSetup(
  target: BridgeSetupTarget,
  packageVersion: string,
): Promise<void> {
  applyDefaultBoardUrl();

  if (target === "codex" || target === "kimi" || target === "antigravity") {
    const interactive = !hasConnectionEnvironment(process.env);
    if (!interactive) {
      await runSingleTargetSetup(target, packageVersion, false);
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "setup 需要交互式终端；非交互安装请提供 AI_TASK_BOARD_CONNECTION_TOKEN 环境变量",
      );
    }
    await runSingleTargetSetup(target, packageVersion, true);
    return;
  }

  // both/all need one token per platform, so non-interactive installation is
  // ambiguous and interactive prompting is always required.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "setup 需要交互式终端；非交互安装请分别运行 setup codex、setup kimi 或 setup antigravity 并提供 AI_TASK_BOARD_CONNECTION_TOKEN",
    );
  }
  const targets: readonly BridgeRunTarget[] =
    target === "both"
      ? (["codex", "kimi"] as const)
      : (["codex", "kimi", "antigravity"] as const);
  process.stdout.write(
    target === "both"
      ? "\n将依次安装两个独立服务。Codex 与 Kimi 需要各自在看板中创建的 Connection Token。\n"
      : "\n将依次安装三个独立服务。Codex、Kimi 与 Antigravity 需要各自在看板中创建的 Connection Token。\n",
  );
  for (const singleTarget of targets) {
    await runSingleTargetSetup(singleTarget, packageVersion, true);
  }
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

  const runtimeModule = "./antigravity-runtime/index.js";
  const { runAntigravityBridgeCli } = (await import(runtimeModule)) as {
    runAntigravityBridgeCli: () => Promise<void>;
  };
  await runAntigravityBridgeCli();
}

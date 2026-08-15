import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";

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
  { value: "antigravity", label: "Antigravity Bridge（Google Antigravity CLI）" },
  { value: "both", label: "Codex Bridge 和 Kimi Bridge" },
  { value: "all", label: "Codex、Kimi 和 Antigravity Bridge" },
];

export function parseBridgeSetupTarget(
  value: string | undefined,
): BridgeSetupTarget | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "codex") return "codex";
  if (normalized === "kimi" || normalized === "kimi-code") return "kimi";
  if (normalized === "antigravity" || normalized === "agy") return "antigravity";
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

export async function promptForBridgeSetupTarget(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<BridgeSetupTarget> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "setup 需要交互式终端；自动化请选择 setup codex、setup kimi、setup antigravity 或 setup all",
    );
  }

  const readline = createInterface({ input, output, terminal: true });
  try {
    output.write("\nAI Task Board Bridge 安装器\n\n要安装什么？\n");
    BRIDGE_SETUP_CHOICES.forEach((choice, index) => {
      output.write(`  ${index + 1}) ${choice.label}\n`);
    });

    while (true) {
      const answer = (await readline.question("请选择 [1]: "))
        .trim()
        .toLowerCase();
      if (!answer) return "codex";
      const numericChoice = Number(answer) - 1;
      if (Number.isInteger(numericChoice) && BRIDGE_SETUP_CHOICES[numericChoice]) {
        return BRIDGE_SETUP_CHOICES[numericChoice].value;
      }
      const namedChoice = parseBridgeSetupTarget(answer);
      if (namedChoice) return namedChoice;
      output.write("  请输入 1 到 5，或 codex、kimi、antigravity、both、all。\n");
    }
  } finally {
    readline.close();
  }
}

async function setupCodex(packageVersion: string): Promise<void> {
  const { runInteractiveSetup } = await import("./setup.js");
  await runInteractiveSetup({ packageVersion });
}

async function setupKimi(packageVersion: string): Promise<void> {
  const runtimeModule = "./kimi-runtime/index.js";
  const { runKimiInteractiveSetup } = (await import(runtimeModule)) as {
    runKimiInteractiveSetup: (options: {
      packageVersion: string;
    }) => Promise<void>;
  };
  await runKimiInteractiveSetup({ packageVersion });
}

async function setupAntigravity(packageVersion: string): Promise<void> {
  const runtimeModule = "./antigravity-runtime/index.js";
  const { runAntigravityInteractiveSetup } = (await import(runtimeModule)) as {
    runAntigravityInteractiveSetup: (options: {
      packageVersion: string;
    }) => Promise<void>;
  };
  await runAntigravityInteractiveSetup({ packageVersion });
}

export async function runBridgeSetup(
  target: BridgeSetupTarget,
  packageVersion: string,
): Promise<void> {
  if (target === "codex") {
    await setupCodex(packageVersion);
    return;
  }
  if (target === "kimi") {
    await setupKimi(packageVersion);
    return;
  }
  if (target === "antigravity") {
    await setupAntigravity(packageVersion);
    return;
  }

  if (target === "both") {
    process.stdout.write(
      "\n将依次安装两个独立服务。Codex 与 Kimi 需要各自在看板中创建的 Connection Token。\n",
    );
    await setupCodex(packageVersion);
    await setupKimi(packageVersion);
    return;
  }

  process.stdout.write(
    "\n将依次安装三个独立服务。Codex、Kimi 与 Antigravity 需要各自在看板中创建的 Connection Token。\n",
  );
  await setupCodex(packageVersion);
  await setupKimi(packageVersion);
  await setupAntigravity(packageVersion);
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

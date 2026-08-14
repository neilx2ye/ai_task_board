import { createInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";

export type BridgeSetupTarget = "codex" | "kimi" | "both";
export type BridgeRunTarget = Exclude<BridgeSetupTarget, "both">;

export const BRIDGE_SETUP_CHOICES: ReadonlyArray<{
  value: BridgeSetupTarget;
  label: string;
}> = [
  { value: "codex", label: "Codex Bridge" },
  { value: "kimi", label: "Kimi Bridge（Kimi Code ACP）" },
  { value: "both", label: "Codex Bridge 和 Kimi Bridge" },
];

export function parseBridgeSetupTarget(
  value: string | undefined,
): BridgeSetupTarget | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "codex") return "codex";
  if (normalized === "kimi" || normalized === "kimi-code") return "kimi";
  if (normalized === "both" || normalized === "all") return "both";
  return null;
}

export function parseBridgeRunTarget(
  value: string | undefined,
): BridgeRunTarget | null {
  const target = parseBridgeSetupTarget(value);
  return target === "codex" || target === "kimi" ? target : null;
}

export async function promptForBridgeSetupTarget(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<BridgeSetupTarget> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "setup 需要交互式终端；自动化请选择 setup codex、setup kimi 或 setup both",
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
      output.write("  请输入 1 到 3，或 codex、kimi、both。\n");
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

  process.stdout.write(
    "\n将依次安装两个独立服务。Codex 与 Kimi 需要各自在看板中创建的 Connection Token。\n",
  );
  await setupCodex(packageVersion);
  await setupKimi(packageVersion);
}

export async function runAgentBridge(target: BridgeRunTarget): Promise<void> {
  if (target === "codex") {
    const { runBridgeCli } = await import("./bridge.js");
    await runBridgeCli();
    return;
  }

  const runtimeModule = "./kimi-runtime/index.js";
  const { runKimiBridgeCli } = (await import(runtimeModule)) as {
    runKimiBridgeCli: () => Promise<void>;
  };
  await runKimiBridgeCli();
}

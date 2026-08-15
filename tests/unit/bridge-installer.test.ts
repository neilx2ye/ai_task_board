import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";

import { describe, expect, it } from "vitest";

import {
  BRIDGE_SETUP_CHOICES,
  parseBridgeRunTarget,
  parseBridgeSetupTarget,
  promptForBridgeSetupTarget,
} from "@/packages/codex-bridge/src/installer";

describe("unified Bridge installer", () => {
  it("offers Codex, Kimi, Antigravity, and combinations from one setup entry", () => {
    expect(BRIDGE_SETUP_CHOICES.map((choice) => choice.value)).toEqual([
      "codex",
      "kimi",
      "antigravity",
      "both",
      "all",
    ]);
    expect(parseBridgeSetupTarget("KIMI-CODE")).toBe("kimi");
    expect(parseBridgeSetupTarget("AGY")).toBe("antigravity");
    expect(parseBridgeSetupTarget("all")).toBe("all");
    expect(parseBridgeSetupTarget("unknown")).toBeNull();
  });

  it("allows only one runtime for foreground execution", () => {
    expect(parseBridgeRunTarget("codex")).toBe("codex");
    expect(parseBridgeRunTarget("kimi")).toBe("kimi");
    expect(parseBridgeRunTarget("antigravity")).toBe("antigravity");
    expect(parseBridgeRunTarget("both")).toBeNull();
    expect(parseBridgeRunTarget("all")).toBeNull();
  });

  it("accepts an interactive numeric selection", async () => {
    const input = new PassThrough() as unknown as ReadStream;
    const output = new PassThrough() as unknown as WriteStream;
    Object.defineProperty(input, "isTTY", { value: true });
    Object.defineProperty(output, "isTTY", { value: true });
    input.end("2\n");

    await expect(promptForBridgeSetupTarget(input, output)).resolves.toBe(
      "kimi",
    );
  });

  it("publishes one public package and keeps the runtime source workspaces private", async () => {
    const publicManifest = JSON.parse(
      await readFile("packages/codex-bridge/package.json", "utf8"),
    ) as {
      name: string;
      version: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const kimiManifest = JSON.parse(
      await readFile("packages/kimi-bridge/package.json", "utf8"),
    ) as { name: string; private?: boolean };
    const antigravityManifest = JSON.parse(
      await readFile("packages/antigravity-bridge/package.json", "utf8"),
    ) as { name: string; private?: boolean };

    expect(publicManifest.name).toBe("ai-task-board-bridge");
    expect(publicManifest.version).toBe("1.0.1");
    expect(publicManifest.dependencies).not.toHaveProperty(
      "@ai-task-board/kimi-bridge-runtime",
    );
    expect(publicManifest.dependencies).not.toHaveProperty(
      "@ai-task-board/antigravity-bridge-runtime",
    );
    expect(publicManifest.scripts.build).toContain("embed-runtimes.mjs");
    expect(kimiManifest).toMatchObject({
      name: "@ai-task-board/kimi-bridge-runtime",
      private: true,
    });
    expect(antigravityManifest).toMatchObject({
      name: "@ai-task-board/antigravity-bridge-runtime",
      private: true,
    });
  });
});

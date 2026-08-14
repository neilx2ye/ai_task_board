import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  KIMI_FALLBACK_MODEL_CATALOG,
  modelCatalogFromConfigOptions,
} from "../../packages/kimi-bridge/src/acp-client";
import {
  directoryForWorkingDirectory,
  loadConfiguration,
  parseWorkingDirectories,
  workingDirectoryForKey,
} from "../../packages/kimi-bridge/src/config";
import { TurnLimiter } from "../../packages/kimi-bridge/src/bridge";
import { agentModelOptions } from "@/lib/codex-models";

const configOptions: SessionConfigOption[] = [
  {
    id: "model-selector",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "kimi-code/k3",
    options: [
      { value: "kimi-code/k3", name: "K3", description: "Default model" },
      {
        value: "kimi-code/k3-256k",
        name: "K3-256k",
        description: null,
      },
    ],
  },
  {
    id: "thinking-selector",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "max",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
  {
    id: "mode-selector",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "auto",
    options: [
      { value: "default", name: "Default" },
      { value: "auto", name: "Auto" },
    ],
  },
];

describe("Kimi ACP model catalog", () => {
  it("maps live ACP model and thought-level selectors to Board inventory", () => {
    expect(modelCatalogFromConfigOptions(configOptions, true)).toEqual([
      expect.objectContaining({
        model: "kimi-code/k3",
        display_name: "K3",
        default_reasoning_effort: "max",
        input_modalities: ["text", "image"],
        is_default: true,
        supported_reasoning_efforts: [
          { reasoning_effort: "low", description: null },
          { reasoning_effort: "high", description: null },
          { reasoning_effort: "max", description: null },
        ],
      }),
      expect.objectContaining({
        model: "kimi-code/k3-256k",
        is_default: false,
      }),
    ]);
  });

  it("ships a Kimi-only fallback catalog and never falls back to Codex UI models", () => {
    expect(
      KIMI_FALLBACK_MODEL_CATALOG.map((entry) => entry.model),
    ).toEqual([
      "kimi-code/k3",
      "kimi-code/k3-256k",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ]);
    expect(agentModelOptions(null, "Kimi Code")).toEqual([]);
    expect(agentModelOptions(KIMI_FALLBACK_MODEL_CATALOG, "Kimi Code")).toHaveLength(4);
  });
});

describe("Kimi Bridge configuration", () => {
  it("parses an exact multi-directory allowlist", () => {
    const directories = parseWorkingDirectories(
      JSON.stringify([
        { key: "app", name: "Main App", path: "/srv/app" },
        { key: "docs", path: "/srv/docs" },
      ]),
      "/ignored",
    );
    expect(directories).toEqual([
      { key: "app", name: "Main App", workingDirectory: "/srv/app" },
      { key: "docs", name: "docs", workingDirectory: "/srv/docs" },
    ]);
    expect(directoryForWorkingDirectory("/srv/app", directories)?.key).toBe("app");
    expect(directoryForWorkingDirectory("/srv/app/subdir", directories)).toBeNull();
    expect(workingDirectoryForKey("docs", directories)).toBe("/srv/docs");
    expect(() => workingDirectoryForKey("unknown", directories)).toThrow(
      "本机白名单",
    );
  });

  it("loads execution and approval policy without accepting invalid values", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com/",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_token_value",
      KIMI_WORKING_DIRECTORY: "/srv/app",
      KIMI_BRIDGE_MODE: "plan",
      KIMI_BRIDGE_APPROVAL_MODE: "decline",
      KIMI_MAX_THREADS: "12",
      KIMI_MAX_CONCURRENT_TURNS: "3",
    });
    expect(configuration).toMatchObject({
      boardUrl: "https://board.example.com",
      agentMode: "plan",
      approvalMode: "decline",
      maxThreads: 12,
      maxConcurrentTurns: 3,
      kimiBinary: "kimi",
    });
    expect(() =>
      loadConfiguration({
        AI_TASK_BOARD_URL: "https://board.example.com",
        AI_TASK_BOARD_CONNECTION_TOKEN: "token",
        KIMI_BRIDGE_MODE: "unsafe",
      }),
    ).toThrow("KIMI_BRIDGE_MODE");
  });
});

describe("Kimi Bridge turn limiter", () => {
  it("queues a second turn until the first permit is released", async () => {
    const limiter = new TurnLimiter(1);
    const first = await limiter.acquire(new AbortController().signal);
    let acquired = false;
    const secondPromise = limiter
      .acquire(new AbortController().signal)
      .then((release) => {
        acquired = true;
        return release;
      });
    await Promise.resolve();
    expect(acquired).toBe(false);
    first();
    const second = await secondPromise;
    expect(acquired).toBe(true);
    second();
  });
});

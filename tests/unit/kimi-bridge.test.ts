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
import {
  resolveRemoteConfiguration,
  TurnLimiter,
} from "../../packages/kimi-bridge/src/bridge";
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

describe("Kimi Bridge remote configuration", () => {
  const base = loadConfiguration({
    AI_TASK_BOARD_URL: "https://board.example.com",
    AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_token_value",
    KIMI_WORKING_DIRECTORY: "/srv/app",
    KIMI_MAX_THREADS: "8",
    KIMI_BRIDGE_ALLOW_REMOTE_THREAD_TITLES: "true",
  });

  it("applies the Web thread limit without a local ceiling and ignores unsupported fields", () => {
    const resolved = resolveRemoteConfiguration(base, {
      enabled: false,
      include_thread_titles: true,
      max_threads: 20,
      max_concurrent_turns: 4,
      sync_history: true,
      history_turn_limit: 500,
      working_directories: [],
    });
    expect(resolved.effective).toEqual({
      enabled: false,
      includeThreadTitles: true,
      maxThreads: 20,
      maxConcurrentTurns: 4,
      syncHistory: false,
      historyTurnLimit: 500,
      workingDirectories: base.localWorkingDirectories,
    });
    expect(resolved.warnings.join("")).not.toContain("max_threads");
    expect(resolved.warnings.join("")).toContain("历史同步");
    expect(resolved.warnings.join("")).toContain("工作目录");
  });

  it("rejects invalid desired values and honors the local title authorization", () => {
    expect(() =>
      resolveRemoteConfiguration(base, {
        enabled: true,
        include_thread_titles: true,
        max_threads: 1.5,
        max_concurrent_turns: 2,
        sync_history: false,
        history_turn_limit: 50,
        working_directories: null,
      }),
    ).toThrow("max_threads 必须是整数");

    const blocked = resolveRemoteConfiguration(
      { ...base, allowRemoteThreadTitles: false },
      {
        enabled: true,
        include_thread_titles: true,
        max_threads: 2,
        max_concurrent_turns: 2,
        sync_history: false,
        history_turn_limit: 50,
        working_directories: null,
      },
    );
    expect(blocked.effective.includeThreadTitles).toBe(false);
    expect(blocked.warnings.join("")).toContain(
      "KIMI_BRIDGE_ALLOW_REMOTE_THREAD_TITLES",
    );
  });

  it("parses the Web config opt-in and uses the local value only as startup fallback", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_token_value",
      KIMI_WORKING_DIRECTORY: "/srv/app",
      KIMI_MAX_THREADS: "7",
      KIMI_BRIDGE_WEB_CONFIG: "true",
    });
    expect(configuration.webConfigurationEnabled).toBe(true);
    expect(configuration.enabled).toBe(true);
    expect(configuration.localMaxThreads).toBe(7);
    expect(configuration.maxThreads).toBe(7);
    expect(configuration.historyTurnLimit).toBe(50);
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

  it("resizes capacity when a remote concurrency limit is applied", async () => {
    const limiter = new TurnLimiter(2);
    const first = await limiter.acquire(new AbortController().signal);
    const second = await limiter.acquire(new AbortController().signal);
    limiter.resize(1);
    let acquired = false;
    const thirdPromise = limiter
      .acquire(new AbortController().signal)
      .then((release) => {
        acquired = true;
        return release;
      });
    await Promise.resolve();
    expect(acquired).toBe(false);
    first();
    await Promise.resolve();
    expect(acquired).toBe(false);
    second();
    const third = await thirdPromise;
    expect(acquired).toBe(true);
    third();
  });
});

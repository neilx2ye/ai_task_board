import { getEventListeners } from "node:events";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  bridgeConfigurationConstraints,
  delay,
  effectiveBridgeConfiguration,
  isExactWorkingDirectory,
  loadConfiguration,
  managedDirectoryForWorkingDirectory,
  parseRemoteWorkingDirectories,
  parseWorkingDirectories,
  remoteWorkingDirectories,
  resolveRemoteConfiguration,
  stopWorkersForRetirement,
  TurnLimiter,
  workingDirectoryForThreadCreate,
} from "../../packages/codex-bridge/src/bridge";

describe("Codex Bridge runtime primitives", () => {
  it("parses an exact multi-directory allowlist with a stable default", () => {
    const directories = parseWorkingDirectories(
      JSON.stringify([
        { key: "main", name: "Main app", path: "/workspace/main" },
        { key: "docs", path: "/workspace/docs" },
      ]),
      "/workspace/fallback",
    );

    expect(directories).toEqual([
      {
        key: "main",
        name: "Main app",
        workingDirectory: "/workspace/main",
      },
      {
        key: "docs",
        name: "docs",
        workingDirectory: "/workspace/docs",
      },
    ]);
    expect(
      managedDirectoryForWorkingDirectory("/workspace/docs", directories),
    ).toMatchObject({ key: "docs" });
    expect(
      managedDirectoryForWorkingDirectory(
        "/workspace/docs/child",
        directories,
      ),
    ).toBeNull();
    expect(
      workingDirectoryForThreadCreate(
        "docs",
        directories,
        "/workspace/fallback",
      ),
    ).toBe("/workspace/docs");
    expect(() =>
      workingDirectoryForThreadCreate(
        "unknown",
        directories,
        "/workspace/fallback",
      ),
    ).toThrow("本机白名单");

    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_WORKING_DIRECTORY: "/workspace/legacy",
      CODEX_WORKING_DIRECTORIES: JSON.stringify([
        { key: "main", path: "/workspace/main" },
        { key: "docs", path: "/workspace/docs" },
      ]),
    });
    expect(configuration.workingDirectory).toBe("/workspace/main");
    expect(configuration.workingDirectories).toHaveLength(2);
    expect(configuration.localWorkingDirectory).toBe("/workspace/main");
    expect(configuration.localWorkingDirectories).toEqual(
      configuration.workingDirectories,
    );

    expect(() =>
      parseWorkingDirectories(
        JSON.stringify([
          { key: "same", path: "/workspace/main" },
          { key: "same", path: "/workspace/docs" },
        ]),
        "/workspace/fallback",
      ),
    ).toThrow("重复 key");
  });

  it("strictly validates absolute Board-provided working directories", () => {
    const directories = parseRemoteWorkingDirectories([
      {
        directory_key: "root",
        name: "Repository root",
        working_directory: process.cwd(),
      },
      {
        directory_key: "packages",
        name: "Packages",
        working_directory: path.resolve("packages"),
      },
    ]);

    expect(remoteWorkingDirectories(directories)).toEqual([
      {
        directory_key: "root",
        name: "Repository root",
        working_directory: process.cwd(),
      },
      {
        directory_key: "packages",
        name: "Packages",
        working_directory: path.resolve("packages"),
      },
    ]);
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "relative",
          name: "Relative",
          working_directory: "packages",
        },
      ]),
    ).toThrow("必须是绝对路径");
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "file",
          name: "File",
          working_directory: path.resolve("package.json"),
        },
      ]),
    ).toThrow("不存在或不是目录");
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "one",
          name: "One",
          working_directory: process.cwd(),
        },
        {
          directory_key: "two",
          name: "Two",
          working_directory: process.cwd(),
        },
      ]),
    ).toThrow("重复路径");
    expect(parseRemoteWorkingDirectories([])).toEqual([]);
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "same",
          name: "Repository root",
          working_directory: process.cwd(),
        },
        {
          directory_key: "same",
          name: "Packages",
          working_directory: path.resolve("packages"),
        },
      ]),
    ).toThrow("重复 key");
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "root",
          name: "Repository root",
          working_directory: process.cwd(),
          path: process.cwd(),
        },
      ]),
    ).toThrow("未知字段");
  });

  it("removes delay abort listeners after normal completion", async () => {
    const controller = new AbortController();

    await delay(1, controller.signal);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("removes queued limiter abort listeners when a permit is granted", async () => {
    const limiter = new TurnLimiter(1);
    const firstController = new AbortController();
    const firstRelease = await limiter.acquire(firstController.signal);
    const queuedController = new AbortController();
    const queued = limiter.acquire(queuedController.signal);

    expect(getEventListeners(queuedController.signal, "abort")).toHaveLength(1);
    firstRelease();
    const secondRelease = await queued;

    expect(getEventListeners(queuedController.signal, "abort")).toHaveLength(0);
    secondRelease();
  });

  it("resizes concurrency without revoking active permits", async () => {
    const limiter = new TurnLimiter(2);
    const firstRelease = await limiter.acquire(new AbortController().signal);
    const secondRelease = await limiter.acquire(new AbortController().signal);
    limiter.resize(1);

    let thirdGranted = false;
    const third = limiter.acquire(new AbortController().signal).then((release) => {
      thirdGranted = true;
      return release;
    });
    firstRelease();
    await delay(5);
    expect(thirdGranted).toBe(false);

    limiter.resize(2);
    const thirdRelease = await third;
    expect(thirdGranted).toBe(true);
    expect(limiter.capacity).toBe(2);
    secondRelease();
    thirdRelease();
  });

  it("defaults to full access with automatic approval and keeps explicit permission modes", () => {
    const defaults = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
    });

    expect(defaults.permissionMode).toBe("danger-full-access");
    expect(defaults.approvalMode).toBe("accept");
    expect(defaults.maxConcurrentTurns).toBe(5);
    expect(bridgeConfigurationConstraints(defaults)).toMatchObject({
      permission_mode: "danger-full-access",
      approval_mode: "accept",
    });

    const safe = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_BRIDGE_PERMISSION_MODE: "safe",
      CODEX_BRIDGE_APPROVAL_MODE: "accept-session",
    });
    expect(safe.permissionMode).toBe("safe");
    expect(safe.approvalMode).toBe("accept-session");

    const inherited = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_BRIDGE_PERMISSION_MODE: "inherit",
      CODEX_BRIDGE_APPROVAL_MODE: "decline",
    });
    expect(inherited.permissionMode).toBe("inherit");
    expect(inherited.approvalMode).toBe("decline");

    expect(() =>
      loadConfiguration({
        AI_TASK_BOARD_URL: "https://board.example.com",
        AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
        CODEX_BRIDGE_PERMISSION_MODE: "typo",
      }),
    ).toThrow("CODEX_BRIDGE_PERMISSION_MODE");
    expect(() =>
      loadConfiguration({
        AI_TASK_BOARD_URL: "https://board.example.com",
        AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
        CODEX_BRIDGE_APPROVAL_MODE: "typo",
      }),
    ).toThrow("CODEX_BRIDGE_APPROVAL_MODE");
  });

  it("lets Web own every remote-configurable field without device authorization", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_WORKING_DIRECTORY: "/workspace/safe",
      CODEX_THREAD_SCOPE: "cwd",
      CODEX_MAX_THREADS: "5",
      CODEX_MAX_CONCURRENT_TURNS: "3",
      CODEX_BRIDGE_PERMISSION_MODE: "safe",
    });

    expect(configuration.webConfigurationEnabled).toBe(true);
    expect(configuration.allowRemoteThreadTitles).toBe(true);
    expect(configuration.allowHistorySync).toBe(true);
    expect(configuration.allowRemoteWorkingDirectories).toBe(true);
    const resolved = resolveRemoteConfiguration(configuration, {
      enabled: false,
      include_thread_titles: true,
      max_threads: 500,
      max_concurrent_turns: 32,
      working_directories: [
        {
          directory_key: "remote",
          name: "Remote",
          working_directory: path.resolve("packages"),
        },
      ],
      // Web now owns the safety modes; unrelated fields stay ignored.
      thread_scope: "all",
      permission_mode: "inherit",
    } as never);

    expect(resolved.effective).toEqual({
      enabled: false,
      includeThreadTitles: true,
      maxThreads: 500,
      maxConcurrentTurns: 32,
      syncHistory: false,
      historyTurnLimit: 50,
      permissionMode: "inherit",
      approvalMode: "accept",
      workingDirectory: path.resolve("packages"),
      workingDirectories: [
        {
          key: "remote",
          name: "Remote",
          workingDirectory: path.resolve("packages"),
        },
      ],
    });
    expect(resolved.warnings).toEqual([]);
    expect(bridgeConfigurationConstraints(configuration)).toMatchObject({
      remote_configuration_enabled: true,
      allow_thread_titles: true,
      allow_working_directory_configuration: true,
      max_threads: 500,
      max_concurrent_turns: 32,
      allow_history_sync: true,
      max_history_turns: 500,
      thread_scope: "cwd",
      working_directory: "/workspace/safe",
      permission_mode: "safe",
      approval_mode: "accept",
    });
    expect(effectiveBridgeConfiguration(configuration)).toMatchObject({
      enabled: true,
      includeThreadTitles: false,
    });
    expect(configuration.threadScope).toBe("cwd");
    expect(configuration.permissionMode).toBe("safe");
    expect(configuration.approvalMode).toBe("accept");
    expect(
      loadConfiguration({
        AI_TASK_BOARD_URL: "https://board.example.com",
        AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
        CODEX_BRIDGE_APPROVAL_MODE: "decline",
      }).approvalMode,
    ).toBe("decline");
    expect(configuration.syncHistory).toBe(false);
    expect(configuration.localMaxHistoryTurns).toBe(50);
  });

  it("applies Board working directories without a device authorization gate", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_WORKING_DIRECTORY: process.cwd(),
      CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES: "true",
    });
    const resolved = resolveRemoteConfiguration(configuration, {
      enabled: true,
      include_thread_titles: false,
      max_threads: 1,
      max_concurrent_turns: 1,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: [
        {
          directory_key: "packages",
          name: "Packages",
          working_directory: path.resolve("packages"),
        },
      ],
    });

    expect(configuration.localWorkingDirectory).toBe(process.cwd());
    expect(configuration.workingDirectory).toBe(process.cwd());
    expect(resolved.effective.workingDirectory).toBe(path.resolve("packages"));
    expect(resolved.effective.workingDirectories).toEqual([
      {
        key: "packages",
        name: "Packages",
        workingDirectory: path.resolve("packages"),
      },
    ]);
    expect(resolved.warnings).toEqual([]);
    expect(bridgeConfigurationConstraints(configuration)).toMatchObject({
      allow_working_directory_configuration: true,
      working_directory: process.cwd(),
    });

    configuration.workingDirectory = resolved.effective.workingDirectory;
    configuration.workingDirectories =
      resolved.effective.workingDirectories;
    const reverted = resolveRemoteConfiguration(configuration, {
      enabled: true,
      include_thread_titles: false,
      max_threads: 1,
      max_concurrent_turns: 1,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: null,
    });
    expect(reverted.effective.workingDirectory).toBe(process.cwd());
    expect(reverted.effective.workingDirectories).toEqual(
      configuration.localWorkingDirectories,
    );
  });

  it("applies Web history sync and its turn budget without device authorization", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_BRIDGE_MAX_HISTORY_TURNS: "200",
    });
    const resolved = resolveRemoteConfiguration(configuration, {
      enabled: true,
      include_thread_titles: false,
      max_threads: 1,
      max_concurrent_turns: 1,
      sync_history: true,
      history_turn_limit: 500,
      working_directories: null,
    });
    expect(resolved.effective).toMatchObject({
      syncHistory: true,
      historyTurnLimit: 500,
    });
    expect(resolved.warnings).toEqual([]);
  });

  it("applies Web titles without device authorization", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_BRIDGE_WEB_CONFIG: "true",
      CODEX_BRIDGE_INCLUDE_THREAD_TITLES: "true",
    });
    const resolved = resolveRemoteConfiguration(configuration, {
      enabled: true,
      include_thread_titles: true,
      max_threads: 1,
      max_concurrent_turns: 1,
      working_directories: null,
    });

    expect(configuration.webConfigurationEnabled).toBe(true);
    expect(configuration.allowRemoteThreadTitles).toBe(true);
    expect(resolved.effective.includeThreadTitles).toBe(true);
  });

  it("defaults the runtime lease to 120 seconds independent of config poll", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "600000",
    });

    expect(configuration.configurationPollIntervalMs).toBe(600_000);
    expect(configuration.configurationLeaseSeconds).toBe(120);
  });

  it("allows the runtime lease to be raised through the environment", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_BRIDGE_RUNTIME_LEASE_SECONDS: "300",
    });

    expect(configuration.configurationLeaseSeconds).toBe(300);
  });

  it("fails closed and preserves the worker mapping when retirement rejects", async () => {
    let stopAttempts = 0;
    const worker = {
      async stop() {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("transient stop failure");
      },
    };
    const workers = new Map([["thread-a", worker]]);
    const removed = [{ threadId: "thread-a", worker }];

    await expect(
      stopWorkersForRetirement(removed, "test retirement"),
    ).rejects.toThrow("保留本地映射并终止 Bridge");
    expect(workers.has("thread-a")).toBe(true);

    await stopWorkersForRetirement(removed, "retry retirement");
    for (const { threadId } of removed) workers.delete(threadId);
    expect(stopAttempts).toBe(2);
    expect(workers.has("thread-a")).toBe(false);
  });

  it("matches cwd scope exactly without path-prefix bypasses", () => {
    expect(isExactWorkingDirectory("/workspace/app", "/workspace/app")).toBe(true);
    expect(isExactWorkingDirectory("/workspace/app/child", "/workspace/app")).toBe(false);
    expect(isExactWorkingDirectory("/workspace/app-evil", "/workspace/app")).toBe(false);
  });
});

import { getEventListeners } from "node:events";

import { describe, expect, it } from "vitest";

import {
  bridgeConfigurationConstraints,
  delay,
  effectiveBridgeConfiguration,
  isExactWorkingDirectory,
  loadConfiguration,
  resolveRemoteConfiguration,
  stopWorkersForRetirement,
  TurnLimiter,
} from "../../packages/codex-bridge/src/bridge";

describe("Codex Bridge runtime primitives", () => {
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

  it("keeps Web configuration behind local gates and local maxima", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      CODEX_WORKING_DIRECTORY: "/workspace/safe",
      CODEX_THREAD_SCOPE: "cwd",
      CODEX_MAX_THREADS: "5",
      CODEX_MAX_CONCURRENT_TURNS: "3",
      CODEX_BRIDGE_PERMISSION_MODE: "safe",
      CODEX_BRIDGE_APPROVAL_MODE: "decline",
    });

    expect(configuration.webConfigurationEnabled).toBe(false);
    expect(configuration.allowRemoteThreadTitles).toBe(false);
    const resolved = resolveRemoteConfiguration(configuration, {
      enabled: false,
      include_thread_titles: true,
      max_threads: 500,
      max_concurrent_turns: 32,
      // Extra fields from an untrusted response cannot expand local authority.
      thread_scope: "all",
      permission_mode: "inherit",
    } as never);

    expect(resolved.effective).toEqual({
      enabled: false,
      includeThreadTitles: false,
      maxThreads: 5,
      maxConcurrentTurns: 3,
    });
    expect(resolved.warnings).toHaveLength(3);
    expect(bridgeConfigurationConstraints(configuration)).toMatchObject({
      remote_configuration_enabled: false,
      allow_thread_titles: false,
      max_threads: 5,
      max_concurrent_turns: 3,
      thread_scope: "cwd",
      working_directory: "/workspace/safe",
      permission_mode: "safe",
      approval_mode: "decline",
    });
    expect(effectiveBridgeConfiguration(configuration)).toMatchObject({
      enabled: true,
      includeThreadTitles: false,
    });
    expect(configuration.threadScope).toBe("cwd");
    expect(configuration.permissionMode).toBe("safe");
    expect(configuration.approvalMode).toBe("decline");
  });

  it("treats an existing local title opt-in as permission for Web titles", () => {
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
    });

    expect(configuration.webConfigurationEnabled).toBe(true);
    expect(configuration.allowRemoteThreadTitles).toBe(true);
    expect(resolved.effective.includeThreadTitles).toBe(true);
  });

  it("caps the runtime lease at 30 seconds even with a long config poll", () => {
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: "https://board.example.com",
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test",
      AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "600000",
    });

    expect(configuration.configurationPollIntervalMs).toBe(600_000);
    expect(configuration.configurationLeaseSeconds).toBe(30);
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

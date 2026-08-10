import { getEventListeners } from "node:events";

import { describe, expect, it } from "vitest";

import {
  delay,
  isExactWorkingDirectory,
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

  it("matches cwd scope exactly without path-prefix bypasses", () => {
    expect(isExactWorkingDirectory("/workspace/app", "/workspace/app")).toBe(true);
    expect(isExactWorkingDirectory("/workspace/app/child", "/workspace/app")).toBe(false);
    expect(isExactWorkingDirectory("/workspace/app-evil", "/workspace/app")).toBe(false);
  });
});

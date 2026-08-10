import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adaptiveIdlePollDelay,
  consumeWakeEventStream,
  reconnectDelay,
  runSessionWakeListener,
  WakeLatch,
} from "@/lib/bridge/wake-client";

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex Bridge wake scheduling", () => {
  it("backs off empty offline claims and keeps a low-frequency Realtime fallback", () => {
    const delay = (emptyPolls: number, realtimeAvailable = false) =>
      adaptiveIdlePollDelay({
        baseIntervalMs: 5_000,
        emptyPolls,
        realtimeAvailable,
        random: () => 0.5,
      });

    expect([0, 1, 2, 3, 4].map((count) => delay(count))).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      60_000,
    ]);
    expect(delay(100)).toBe(60_000);
    expect(delay(0, true)).toBe(60_000);
  });

  it("bounds reconnect jitter", () => {
    expect(reconnectDelay(0, () => 0)).toBe(750);
    expect(reconnectDelay(0, () => 1)).toBe(1_250);
    expect(reconnectDelay(100, () => 1)).toBe(30_000);
  });

  it("retains and coalesces early wake notifications", async () => {
    vi.useFakeTimers();
    const latch = new WakeLatch();
    const controller = new AbortController();

    latch.wake();
    latch.wake();
    await expect(latch.wait(1_000, controller.signal)).resolves.toBe("wake");

    const timedOut = latch.wait(1_000, controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timedOut).resolves.toBe("timeout");

    const aborted = latch.wait(1_000, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBe("aborted");
  });
});

describe("Codex Bridge wake SSE client", () => {
  it("parses split frames and ignores all SSE data fields", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [
          "event: rea",
          "dy\ndata: {}\n\n",
          ": keepalive\n\n",
          'event: wake\ndata: {"title":"do not surface","claim_token":"secret"}\n\n',
          "event: reconnect\ndata: {}\n\n",
        ]) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const onReady = vi.fn();
    const onWake = vi.fn();

    await consumeWakeEventStream(
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      }),
      { onReady, onWake },
    );

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledWith();
  });

  it("authenticates in headers, never in the URL, and disables a missing endpoint", async () => {
    const logs: string[] = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return new Response("missing", { status: 404 });
      },
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();

    await runSessionWakeListener({
      endpoint: "https://board.example/api/ai/sessions/wake",
      connectionToken: "atb_connection_secret",
      sessionId: "44444444-4444-4444-8444-444444444444",
      signal: controller.signal,
      onWake: vi.fn(),
      onAvailabilityChange: vi.fn(),
      log: (message) => logs.push(message),
      fetchImpl,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://board.example/api/ai/sessions/wake",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer atb_connection_secret",
        "X-AI-Session-ID": "44444444-4444-4444-8444-444444444444",
      },
    });
    expect(logs.join("\n")).toContain("改用自适应轮询");
  });

  it("marks a subscribed stream available, seals the claim race, and cleans up", async () => {
    const controller = new AbortController();
    const availability: boolean[] = [];
    const onWake = vi.fn(() => controller.abort());
    const fetchImpl = vi.fn(async () =>
      new Response(
        "event: ready\ndata: {}\n\nevent: reconnect\ndata: {}\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    ) as unknown as typeof fetch;

    await runSessionWakeListener({
      endpoint: "https://board.example/api/ai/sessions/wake",
      connectionToken: "atb_connection_secret",
      sessionId: "44444444-4444-4444-8444-444444444444",
      signal: controller.signal,
      onWake,
      onAvailabilityChange: (available) => availability.push(available),
      fetchImpl,
    });

    expect(onWake).toHaveBeenCalledTimes(1);
    expect(availability).toEqual([true, false]);
  });

  it("reconnects after a transient failure while polling remains authoritative", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      void milliseconds;
      void signal;
    });
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response("event: ready\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

    await runSessionWakeListener({
      endpoint: "https://board.example/api/ai/sessions/wake",
      connectionToken: "atb_connection_secret",
      sessionId: "44444444-4444-4444-8444-444444444444",
      signal: controller.signal,
      onWake: () => controller.abort(),
      onAvailabilityChange: vi.fn(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep,
      random: () => 0.5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0]?.[0]).toBe(2_000);
  });

  it("backs off a data-free degraded frame instead of reconnecting in a tight loop", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      void milliseconds;
      void signal;
    });
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("event: degraded\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("event: ready\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

    await runSessionWakeListener({
      endpoint: "https://board.example/api/ai/sessions/wake",
      connectionToken: "atb_connection_secret",
      sessionId: "44444444-4444-4444-8444-444444444444",
      signal: controller.signal,
      onWake: () => controller.abort(),
      onAvailabilityChange: vi.fn(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep,
      random: () => 0.5,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]?.[0]).toBe(2_000);
  });
});

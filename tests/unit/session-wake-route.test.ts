import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectionId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "11111111-1111-4111-8111-111111111111";

const authMocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  authorizeAISession: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/auth/ai-auth", () => ({
  authenticateAIRequest: authMocks.authenticateAIRequest,
  authorizeAISession: authMocks.authorizeAISession,
  sessionIdFromRequest: (request: Request) =>
    request.headers.get("x-ai-session-id")?.trim() ?? "",
}));

vi.mock("@/lib/db", () => ({
  query: queryMocks.query,
}));

import { GET } from "@/app/api/ai/sessions/wake/route";
import { AppError } from "@/lib/domain/errors";

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return new TextDecoder().decode(value);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();

  authMocks.authenticateAIRequest.mockResolvedValue({
    connectionId,
    tokenHash: "connection-token-hash",
    workspaceId,
  });
  authMocks.authorizeAISession.mockResolvedValue({
    connectionId,
    sessionId,
    tokenHash: "connection-token-hash",
    workspaceId,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AI Session wake SSE route", () => {
  it("polls the assigned task queue and emits data-free wake hints", async () => {
    const pollDeferred: { resolve?: (rows: unknown[]) => void } = {};
    queryMocks.query.mockImplementation(
      () =>
        new Promise((resolve) => {
          pollDeferred.resolve = (rows) => resolve({ rows });
        }),
    );

    const abortController = new AbortController();
    const request = new Request("http://localhost/api/ai/sessions/wake", {
      headers: {
        Authorization: "Bearer atb_connection_secret",
        "X-AI-Session-ID": sessionId,
      },
      signal: abortController.signal,
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, no-transform",
    );
    expect(response.headers.get("content-encoding")).toBe("identity");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(authMocks.authenticateAIRequest).toHaveBeenCalledWith(request);
    expect(authMocks.authorizeAISession).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, workspaceId }),
      sessionId,
    );

    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe("retry: 2000\n\n");
    expect(await readChunk(reader)).toBe("event: ready\ndata: {}\n\n");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(queryMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("assigned_session_id = $1::uuid"),
      [sessionId],
    );
    pollDeferred.resolve?.([]);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);
    pollDeferred.resolve?.([{ "?column?": 1 }]);
    const wakeFrame = await vi.waitFor(async () => {
      const frame = await readChunk(reader);
      return frame;
    });
    expect(wakeFrame).toBe("event: wake\ndata: {}\n\n");

    abortController.abort();
  });

  it("rejects an invalid token before starting the poll", async () => {
    authMocks.authenticateAIRequest.mockRejectedValueOnce(
      new AppError("AUTHENTICATION_REQUIRED", "invalid token"),
    );

    const response = await GET(
      new Request("http://localhost/api/ai/sessions/wake", {
        headers: { "X-AI-Session-ID": sessionId },
      }),
    );

    expect(response.status).toBe(401);
    expect(queryMocks.query).not.toHaveBeenCalled();
  });

  it("emits a degraded frame and closes when the poll fails", async () => {
    queryMocks.query.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(
      new Request("http://localhost/api/ai/sessions/wake", {
        headers: {
          Authorization: "Bearer atb_connection_secret",
          "X-AI-Session-ID": sessionId,
        },
      }),
    );
    const reader = response.body!.getReader();

    expect(await readChunk(reader)).toBe("retry: 2000\n\n");
    expect(await readChunk(reader)).toBe("event: ready\ndata: {}\n\n");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await readChunk(reader)).toBe("event: degraded\ndata: {}\n\n");
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});

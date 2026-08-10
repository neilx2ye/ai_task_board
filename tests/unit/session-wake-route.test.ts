import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const connectionId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "11111111-1111-4111-8111-111111111111";

const authMocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  authorizeAISession: vi.fn(),
}));

const realtimeMocks = vi.hoisted(() => {
  const state: {
    change?: (payload: { new: Record<string, unknown> }) => void;
    config?: Record<string, unknown>;
    status?: (status: string) => void;
  } = {};
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  const admin = {
    channel: vi.fn(),
    removeChannel: vi.fn(),
  };
  return { admin, channel, state };
});

vi.mock("@/lib/auth/ai-auth", () => ({
  authenticateAIRequest: authMocks.authenticateAIRequest,
  authorizeAISession: authMocks.authorizeAISession,
  sessionIdFromRequest: (request: Request) =>
    request.headers.get("x-ai-session-id")?.trim() ?? "",
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => realtimeMocks.admin,
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
  vi.clearAllMocks();
  realtimeMocks.state.change = undefined;
  realtimeMocks.state.config = undefined;
  realtimeMocks.state.status = undefined;

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
  realtimeMocks.admin.channel.mockReturnValue(realtimeMocks.channel);
  realtimeMocks.admin.removeChannel.mockResolvedValue("ok");
  realtimeMocks.channel.on.mockImplementation(
    (_type, config, callback) => {
      realtimeMocks.state.config = config;
      realtimeMocks.state.change = callback;
      return realtimeMocks.channel;
    },
  );
  realtimeMocks.channel.subscribe.mockImplementation((callback) => {
    realtimeMocks.state.status = callback;
    return realtimeMocks.channel;
  });
});

describe("AI Session wake SSE route", () => {
  it("filters one authorized session and emits data-free wake hints", async () => {
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
    expect(response.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(authMocks.authenticateAIRequest).toHaveBeenCalledWith(request);
    expect(authMocks.authorizeAISession).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, workspaceId }),
      sessionId,
    );
    expect(realtimeMocks.state.config).toEqual({
      event: "*",
      schema: "public",
      table: "tasks",
      filter: `assigned_session_id=eq.${sessionId}`,
    });

    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe("retry: 2000\n\n");

    realtimeMocks.state.status?.("SUBSCRIBED");
    expect(await readChunk(reader)).toBe("event: ready\ndata: {}\n\n");

    realtimeMocks.state.change?.({
      new: {
        status: "running",
        title: "must not be streamed",
        claim_token: "must-not-leak",
      },
    });
    realtimeMocks.state.change?.({
      new: {
        status: "ready",
        title: "must not be streamed",
        description: "must-not-leak",
      },
    });
    const wakeFrame = await readChunk(reader);
    expect(wakeFrame).toBe("event: wake\ndata: {}\n\n");
    expect(wakeFrame).not.toContain("title");
    expect(wakeFrame).not.toContain("claim");

    abortController.abort();
    await vi.waitFor(() => {
      expect(realtimeMocks.admin.removeChannel).toHaveBeenCalledWith(
        realtimeMocks.channel,
      );
    });
  });

  it("rejects an invalid token before creating a Realtime channel", async () => {
    authMocks.authenticateAIRequest.mockRejectedValueOnce(
      new AppError("AUTHENTICATION_REQUIRED", "invalid token"),
    );

    const response = await GET(
      new Request("http://localhost/api/ai/sessions/wake", {
        headers: { "X-AI-Session-ID": sessionId },
      }),
    );

    expect(response.status).toBe(401);
    expect(realtimeMocks.admin.channel).not.toHaveBeenCalled();
  });

  it("cleans up a channel when Realtime setup throws synchronously", async () => {
    realtimeMocks.channel.subscribe.mockImplementationOnce(() => {
      throw new Error("socket setup failed");
    });
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
    expect(await readChunk(reader)).toBe("event: degraded\ndata: {}\n\n");
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(realtimeMocks.admin.removeChannel).toHaveBeenCalledWith(
      realtimeMocks.channel,
    );
  });
});

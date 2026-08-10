import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const runtimeId = "44444444-4444-4444-8444-444444444444";

const authMocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  authorizeAISession: vi.fn(),
}));
const domainMocks = vi.hoisted(() => ({ importSessionHistory: vi.fn() }));

vi.mock("@/lib/auth/ai-auth", () => ({
  authenticateAIRequest: authMocks.authenticateAIRequest,
  authorizeAISession: authMocks.authorizeAISession,
  sessionIdFromRequest: (request: Request) =>
    request.headers.get("x-ai-session-id")?.trim() ?? "",
}));
vi.mock("@/lib/domain/session-history", () => ({
  importSessionHistory: domainMocks.importSessionHistory,
}));

import { POST } from "@/app/api/ai/sessions/history/route";
import { AppError } from "@/lib/domain/errors";
import { AI_HISTORY_BODY_LIMIT_BYTES } from "@/lib/http/ai-route";
import { importSessionHistorySchema } from "@/lib/validation/ai";

const sync = {
  status: "complete" as const,
  turn_limit: 50,
  scanned_turns: 1,
  total_turns: 1,
  next_cursor: null,
  error: null,
};

const item = {
  external_ref: "codex-history:thread-1:turn-1:item-1",
  kind: "assistant_message" as const,
  content: "Final answer",
  occurred_at: "2026-08-01T00:00:00.000Z",
  source_order: 1,
  data: {
    protocol: "codex-app-server/v1" as const,
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "item-1",
  },
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/ai/sessions/history", {
    method: "POST",
    headers: {
      Authorization: "Bearer atb_test",
      "Content-Type": "application/json",
      "X-AI-Session-ID": sessionId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.authenticateAIRequest.mockResolvedValue({
    workspaceId,
    connectionId,
    tokenHash: "token-hash",
  });
  authMocks.authorizeAISession.mockResolvedValue({
    workspaceId,
    connectionId,
    sessionId,
    tokenHash: "token-hash",
  });
  domainMocks.importSessionHistory.mockResolvedValue({
    imported: { inserted: 1, replayed: 0 },
    history_sync: { status: "complete", imported_items: 1 },
  });
});

describe("Codex history import validation", () => {
  it("accepts an empty status-only batch", () => {
    expect(
      importSessionHistorySchema.parse({
        runtime_instance_id: runtimeId,
        report_sequence: 1,
        items: [],
        sync: { ...sync, scanned_turns: 0, total_turns: 0 },
      }),
    ).toMatchObject({ items: [], sync: { status: "complete" } });
  });

  it("preserves leading and trailing message whitespace", () => {
    const content = "  ```text\nanswer\n```\n";
    const parsed = importSessionHistorySchema.parse({
      runtime_instance_id: runtimeId,
      report_sequence: 1,
      items: [{ ...item, content }],
      sync,
    });
    expect(parsed.items[0]?.content).toBe(content);
  });

  it("rejects duplicate source refs, arbitrary metadata, and invalid status", () => {
    expect(
      importSessionHistorySchema.safeParse({
        runtime_instance_id: runtimeId,
        report_sequence: 1,
        items: [item, item],
        sync,
      }).success,
    ).toBe(false);
    expect(
      importSessionHistorySchema.safeParse({
        runtime_instance_id: runtimeId,
        report_sequence: 1,
        items: [{ ...item, data: { ...item.data, path: "/secret" } }],
        sync,
      }).success,
    ).toBe(false);
    expect(
      importSessionHistorySchema.safeParse({
        runtime_instance_id: runtimeId,
        report_sequence: 1,
        items: [],
        sync: { ...sync, status: "failed", error: null },
      }).success,
    ).toBe(false);
    expect(
      importSessionHistorySchema.safeParse({
        runtime_instance_id: runtimeId,
        report_sequence: 0,
        items: [],
        sync,
      }).success,
    ).toBe(false);
    expect(
      importSessionHistorySchema.safeParse({
        runtime_instance_id: runtimeId,
        report_sequence: Number.MAX_SAFE_INTEGER + 1,
        items: [],
        sync,
      }).success,
    ).toBe(false);
  });
});

describe("POST /api/ai/sessions/history", () => {
  it("authenticates connection and session before importing the validated batch", async () => {
    const input = {
      runtime_instance_id: runtimeId,
      report_sequence: 1,
      items: [item],
      sync,
    };
    const historyRequest = request(input);
    const response = await POST(historyRequest);

    expect(response.status).toBe(200);
    expect(authMocks.authenticateAIRequest).toHaveBeenCalledWith(
      historyRequest,
    );
    expect(authMocks.authorizeAISession).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, workspaceId }),
      sessionId,
    );
    expect(domainMocks.importSessionHistory).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, sessionId, workspaceId }),
      input,
    );
  });

  it("does not require a request idempotency key because rows own stable refs", async () => {
    const response = await POST(
      request({
        runtime_instance_id: runtimeId,
        report_sequence: 1,
        items: [],
        sync,
      }),
    );
    expect(response.status).toBe(200);
  });

  it("authorizes before rejecting a declared oversized body", async () => {
    const historyRequest = request(
      {
        runtime_instance_id: runtimeId,
        report_sequence: 1,
        items: [],
        sync,
      },
      { "Content-Length": String(AI_HISTORY_BODY_LIMIT_BYTES + 1) },
    );
    const response = await POST(historyRequest);

    expect(response.status).toBe(413);
    expect(authMocks.authenticateAIRequest).toHaveBeenCalledOnce();
    expect(authMocks.authorizeAISession).toHaveBeenCalledOnce();
    expect(domainMocks.importSessionHistory).not.toHaveBeenCalled();
  });

  it("never reads or validates the body after failed authentication", async () => {
    authMocks.authenticateAIRequest.mockRejectedValueOnce(
      new AppError("AUTHENTICATION_REQUIRED", "invalid token"),
    );
    const response = await POST(request({ invalid: true }));

    expect(response.status).toBe(401);
    expect(authMocks.authorizeAISession).not.toHaveBeenCalled();
    expect(domainMocks.importSessionHistory).not.toHaveBeenCalled();
  });
});

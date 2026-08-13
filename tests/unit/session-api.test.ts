import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";

const userContext = { role: "member" as const, userId, workspaceId };
const aiContext = {
  connectionId,
  sessionId,
  tokenHash: "connection-token-hash",
  workspaceId,
};

const domainMocks = vi.hoisted(() => ({
  createSessionTurn: vi.fn(),
  listBridgeDirectories: vi.fn(),
  getSessionConversation: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  reportSessionActivity: vi.fn(),
  syncSessions: vi.fn(),
}));
const routeMocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  authorizeAISession: vi.fn(),
  userContextForRequest: vi.fn(),
  ownerContextForRequest: vi.fn(),
}));

vi.mock("@/lib/domain/users", () => ({
  createSessionTurn: domainMocks.createSessionTurn,
  getSessionConversation: domainMocks.getSessionConversation,
  renameThread: domainMocks.renameThread,
  deleteThread: domainMocks.deleteThread,
}));
vi.mock("@/lib/domain/bridge-directories", () => ({
  listBridgeDirectories: domainMocks.listBridgeDirectories,
}));
vi.mock("@/lib/domain/tasks", () => ({
  reportSessionActivity: domainMocks.reportSessionActivity,
}));
vi.mock("@/lib/domain/sessions", () => ({
  syncSessions: domainMocks.syncSessions,
}));
vi.mock("@/lib/http/user-route", () => ({
  userContextForRequest: routeMocks.userContextForRequest,
  ownerContextForRequest: routeMocks.ownerContextForRequest,
}));
vi.mock("@/lib/auth/ai-auth", () => ({
  authenticateAIRequest: routeMocks.authenticateAIRequest,
  authorizeAISession: routeMocks.authorizeAISession,
  sessionIdFromRequest: (request: Request) =>
    request.headers.get("x-ai-session-id")?.trim() ?? "",
}));

import { POST as reportActivity } from "@/app/api/ai/sessions/activity/route";
import { POST as syncSessions } from "@/app/api/ai/sessions/sync/route";
import { GET as listBridgeDirectories } from "@/app/api/user/bridge-directories/route";
import {
  DELETE as deleteThread,
  GET as getConversation,
  PATCH as renameThread,
} from "@/app/api/user/sessions/[sessionId]/route";
import { POST as createTurn } from "@/app/api/user/sessions/[sessionId]/turns/route";
import { AppError } from "@/lib/domain/errors";
import {
  AI_ACTIVITY_BODY_LIMIT_BYTES,
  AI_INVENTORY_BODY_LIMIT_BYTES,
} from "@/lib/http/ai-route";

function jsonRequest(
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.userContextForRequest.mockResolvedValue(userContext);
  routeMocks.ownerContextForRequest.mockResolvedValue({
    ...userContext,
    role: "owner",
  });
  routeMocks.authenticateAIRequest.mockResolvedValue({
    connectionId,
    tokenHash: aiContext.tokenHash,
    workspaceId,
  });
  routeMocks.authorizeAISession.mockResolvedValue(aiContext);
  domainMocks.getSessionConversation.mockResolvedValue({
    activities: [],
    events: [],
    messages: [],
    pagination: {
      activities: {
        has_more_older: false,
        limit: 100,
        newest_cursor: null,
        oldest_cursor: null,
      },
      legacy: {
        events_truncated: false,
        limit: 5000,
        messages_truncated: false,
        tasks_truncated: false,
      },
    },
    session: { id: sessionId },
    tasks: [],
  });
  domainMocks.listBridgeDirectories.mockResolvedValue({ directories: [] });
  domainMocks.renameThread.mockResolvedValue({ command: { id: "rename" } });
  domainMocks.deleteThread.mockResolvedValue({ command: { id: "delete" } });
  domainMocks.createSessionTurn.mockResolvedValue({ task: { id: taskId } });
  domainMocks.reportSessionActivity.mockResolvedValue({
    activity: { id: 1, kind: "reasoning" },
  });
  domainMocks.syncSessions.mockResolvedValue({
    connection: { id: connectionId },
    sessions: [{ id: sessionId }],
  });
});

describe("Bridge thread inventory REST API", () => {
  it("lists Bridge directories for an authenticated Workspace member", async () => {
    const request = new Request(
      "http://localhost/api/user/bridge-directories",
    );
    const response = await listBridgeDirectories(request);

    expect(response.status).toBe(200);
    expect(routeMocks.userContextForRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.listBridgeDirectories).toHaveBeenCalledWith(userContext);
  });

  it("validates directory inventory and Thread directory membership", async () => {
    const request = jsonRequest(
      "/api/ai/sessions/sync",
      {
        bridge_version: " 0.7.0 ",
        directories: [
          {
            directory_key: " main ",
            name: " Main repository ",
            working_directory: " /srv/main ",
          },
        ],
        threads: [
          {
            external_conversation_ref: " thread-local-1 ",
            name: " Main thread ",
            working_directory: " /srv/main ",
            directory_key: " main ",
          },
        ],
      },
      {
        Authorization: "Bearer atb_test",
        "Idempotency-Key": "bridge/inventory/directories-1",
      },
    );

    const response = await syncSessions(request);

    expect(response.status).toBe(200);
    expect(domainMocks.syncSessions).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, workspaceId }),
      expect.objectContaining({
        bridge_version: "0.7.0",
        directories: [
          {
            directory_key: "main",
            name: "Main repository",
            working_directory: "/srv/main",
          },
        ],
        threads: [
          expect.objectContaining({
            directory_key: "main",
            external_conversation_ref: "thread-local-1",
          }),
        ],
      }),
      "bridge/inventory/directories-1",
    );
  });

  it("rejects a Thread whose directory key is not in the reported allowlist", async () => {
    const response = await syncSessions(
      jsonRequest(
        "/api/ai/sessions/sync",
        {
          bridge_version: "0.7.0",
          directories: [
            {
              directory_key: "main",
              name: "Main",
              working_directory: "/srv/main",
            },
          ],
          threads: [
            {
              external_conversation_ref: "thread-local-1",
              name: "Main thread",
              directory_key: "other",
            },
          ],
        },
        {
          Authorization: "Bearer atb_test",
          "Idempotency-Key": "bridge/inventory/directories-invalid",
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(domainMocks.syncSessions).not.toHaveBeenCalled();
  });

  it("authenticates at connection scope and syncs a normalized full snapshot", async () => {
    const request = jsonRequest(
      "/api/ai/sessions/sync",
      {
        bridge_version: " 0.2.0 ",
        threads: [
          {
            external_conversation_ref: " thread-local-1 ",
            name: " Main repository ",
            working_directory: " /srv/main ",
          },
        ],
      },
      {
        Authorization: "Bearer atb_test",
        "Idempotency-Key": "bridge/inventory/1",
      },
    );

    const response = await syncSessions(request);

    expect(response.status).toBe(200);
    expect(routeMocks.authenticateAIRequest).toHaveBeenCalledWith(request);
    expect(routeMocks.authorizeAISession).not.toHaveBeenCalled();
    expect(domainMocks.syncSessions).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, workspaceId }),
      {
        bridge_version: "0.2.0",
        threads: [
          {
            archived: false,
            capabilities: [],
            external_conversation_ref: "thread-local-1",
            name: "Main repository",
            platform: "codex",
            working_directory: "/srv/main",
          },
        ],
      },
      "bridge/inventory/1",
    );
  });

  it("rejects duplicate thread references after authenticating", async () => {
    const response = await syncSessions(
      jsonRequest(
        "/api/ai/sessions/sync",
        {
          bridge_version: "0.2.0",
          threads: [
            { external_conversation_ref: "same", name: "One" },
            { external_conversation_ref: "same", name: "Two" },
          ],
        },
        {
          Authorization: "Bearer atb_test",
          "Idempotency-Key": "bridge/inventory/duplicate",
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(routeMocks.authenticateAIRequest).toHaveBeenCalledOnce();
    expect(domainMocks.syncSessions).not.toHaveBeenCalled();
  });

  it("rejects an oversized inventory from Content-Length after authentication", async () => {
    const request = jsonRequest(
      "/api/ai/sessions/sync",
      { bridge_version: "0.2.0", threads: [] },
      {
        Authorization: "Bearer atb_test",
        "Content-Length": String(AI_INVENTORY_BODY_LIMIT_BYTES + 1),
        "Idempotency-Key": "bridge/inventory/oversized",
      },
    );

    const response = await syncSessions(request);

    expect(response.status).toBe(413);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(routeMocks.authenticateAIRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.syncSessions).not.toHaveBeenCalled();
  });
});

describe("session conversation REST API", () => {
  it("loads only the validated session in the authenticated workspace", async () => {
    const request = new Request(
      `http://localhost/api/user/sessions/${sessionId}?workspace_id=${workspaceId}`,
    );
    const response = await getConversation(request, {
      params: Promise.resolve({ sessionId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(routeMocks.userContextForRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.getSessionConversation).toHaveBeenCalledWith(
      userContext,
      sessionId,
      { beforeActivityId: undefined, limit: 100 },
    );
  });

  it("queues a trimmed Thread rename for a Workspace owner", async () => {
    const request = jsonRequest(
      `/api/user/sessions/${sessionId}`,
      { name: "  Release work  " },
      { "Idempotency-Key": "web/thread/rename-1" },
    );
    const response = await renameThread(request, {
      params: Promise.resolve({ sessionId }),
    });

    expect(response.status).toBe(202);
    expect(domainMocks.renameThread).toHaveBeenCalledWith(
      expect.objectContaining({ role: "owner" }),
      sessionId,
      { name: "Release work" },
      "web/thread/rename-1",
    );
  });

  it("queues a Thread deletion without consuming a request body", async () => {
    const request = new Request(
      `http://localhost/api/user/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { "Idempotency-Key": "web/thread/delete-1" },
      },
    );
    const response = await deleteThread(request, {
      params: Promise.resolve({ sessionId }),
    });

    expect(response.status).toBe(202);
    expect(domainMocks.deleteThread).toHaveBeenCalledWith(
      expect.objectContaining({ role: "owner" }),
      sessionId,
      "web/thread/delete-1",
    );
  });

  it("passes an exact bigint string cursor without numeric coercion", async () => {
    const cursor = "9007199254740993123";
    const request = new Request(
      `http://localhost/api/user/sessions/${sessionId}?before_activity_id=${cursor}&limit=50`,
    );
    const response = await getConversation(request, {
      params: Promise.resolve({ sessionId }),
    });

    expect(response.status).toBe(200);
    expect(domainMocks.getSessionConversation).toHaveBeenCalledWith(
      userContext,
      sessionId,
      { beforeActivityId: cursor, limit: 50 },
    );
  });

  it.each(["-1", "1e3", "0", "9223372036854775808"])(
    "rejects invalid activity cursor %s",
    async (cursor) => {
      const response = await getConversation(
        new Request(
          `http://localhost/api/user/sessions/${sessionId}?before_activity_id=${cursor}`,
        ),
        { params: Promise.resolve({ sessionId }) },
      );

      expect(response.status).toBe(400);
      expect(domainMocks.getSessionConversation).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid session path before loading conversation data", async () => {
    const response = await getConversation(
      new Request("http://localhost/api/user/sessions/not-a-uuid"),
      { params: Promise.resolve({ sessionId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(routeMocks.userContextForRequest).not.toHaveBeenCalled();
    expect(domainMocks.getSessionConversation).not.toHaveBeenCalled();
  });

  it("creates the next turn with trimmed content and a required idempotency key", async () => {
    const request = jsonRequest(
      `/api/user/sessions/${sessionId}`,
      { content: "  请继续修复派发链路  " },
      { "Idempotency-Key": "  web/session/turn-1  " },
    );
    const response = await createTurn(request, {
      params: Promise.resolve({ sessionId }),
    });

    expect(response.status).toBe(201);
    expect(domainMocks.createSessionTurn).toHaveBeenCalledWith(
      userContext,
      sessionId,
      { content: "请继续修复派发链路" },
      "web/session/turn-1",
    );
  });

  it("accepts image files in a multipart session turn", async () => {
    const form = new FormData();
    form.set("content", "分析截图");
    const image = new File([new Uint8Array([137, 80, 78, 71])], "screen.png", {
      type: "image/png",
    });
    form.append("images", image);
    const response = await createTurn(
      new Request(`http://localhost/api/user/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Idempotency-Key": "turn-with-image" },
        body: form,
      }),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(201);
    expect(domainMocks.createSessionTurn).toHaveBeenCalledWith(
      userContext,
      sessionId,
      {
        content: "分析截图",
        images: [expect.objectContaining({ name: "screen.png", type: "image/png", size: 4 })],
      },
      "turn-with-image",
    );
  });

  it("rejects unsupported session turn image types", async () => {
    const form = new FormData();
    form.set("content", "分析附件");
    form.append("images", new File(["svg"], "unsafe.svg", { type: "image/svg+xml" }));
    const response = await createTurn(
      new Request(`http://localhost/api/user/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "Idempotency-Key": "turn-with-svg" },
        body: form,
      }),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(400);
    expect(domainMocks.createSessionTurn).not.toHaveBeenCalled();
  });

  it("does not dispatch a turn without an idempotency key", async () => {
    const response = await createTurn(
      jsonRequest(`/api/user/sessions/${sessionId}`, { content: "继续" }),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(domainMocks.createSessionTurn).not.toHaveBeenCalled();
  });
});

describe("session activity REST API", () => {
  it("rejects unauthenticated malformed JSON without consuming it first", async () => {
    routeMocks.authenticateAIRequest.mockRejectedValueOnce(
      new AppError("AUTHENTICATION_REQUIRED", "invalid token"),
    );
    const request = new Request("http://localhost/api/ai/sessions/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await reportActivity(request);

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
    expect(routeMocks.authorizeAISession).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it("binds an activity report to the authenticated connection session", async () => {
    const request = jsonRequest(
      "/api/ai/sessions/activity",
      {
        task_id: taskId,
        claim_token: "claim_secret",
        kind: "reasoning",
        content: "  已检查失败测试  ",
        external_ref: "  codex:item:reasoning-1  ",
      },
      {
        Authorization: "Bearer atb_test",
        "Idempotency-Key": "codex/activity/1",
        "X-AI-Session-ID": sessionId,
      },
    );
    const response = await reportActivity(request);

    expect(response.status).toBe(200);
    expect(routeMocks.authorizeAISession).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, workspaceId }),
      sessionId,
    );
    expect(domainMocks.reportSessionActivity).toHaveBeenCalledWith(
      aiContext,
      {
        claim_token: "claim_secret",
        content: "已检查失败测试",
        data: {},
        external_ref: "codex:item:reasoning-1",
        kind: "reasoning",
        task_id: taskId,
      },
      "codex/activity/1",
    );
  });

  it("passes streamed delta content to the domain without trimming", async () => {
    const request = jsonRequest(
      "/api/ai/sessions/activity",
      {
        task_id: taskId,
        claim_token: "claim_secret",
        kind: "assistant_message",
        content: "Hello \n  ",
        data: {
          protocol: "codex-app-server/v1",
          phase: "delta",
        },
        external_ref: "codex:item:message-1:delta:0",
      },
      {
        Authorization: "Bearer atb_test",
        "Idempotency-Key": "codex/activity/delta/0",
        "X-AI-Session-ID": sessionId,
      },
    );

    const response = await reportActivity(request);

    expect(response.status).toBe(200);
    expect(domainMocks.reportSessionActivity).toHaveBeenCalledWith(
      aiContext,
      expect.objectContaining({ content: "Hello \n  " }),
      "codex/activity/delta/0",
    );
  });

  it("accepts a schema-valid multi-byte activity below the byte budget", async () => {
    const content = "界".repeat(100_000);
    const payload = "界".repeat(80_000);
    const request = jsonRequest(
      "/api/ai/sessions/activity",
      {
        task_id: taskId,
        claim_token: "claim_secret",
        kind: "assistant_message",
        content,
        data: { payload },
        external_ref: "codex:item:multibyte",
      },
      {
        Authorization: "Bearer atb_test",
        "Idempotency-Key": "codex/activity/multibyte",
        "X-AI-Session-ID": sessionId,
      },
    );

    const response = await reportActivity(request);

    expect(response.status).toBe(200);
    expect(domainMocks.reportSessionActivity).toHaveBeenCalledWith(
      aiContext,
      expect.objectContaining({ content, data: { payload } }),
      "codex/activity/multibyte",
    );
  });

  it("stops reading an activity body when actual bytes exceed the route limit", async () => {
    const request = jsonRequest(
      "/api/ai/sessions/activity",
      {
        task_id: taskId,
        claim_token: "claim_secret",
        kind: "status",
        data: { payload: "x".repeat(AI_ACTIVITY_BODY_LIMIT_BYTES) },
        external_ref: "codex:item:oversized",
      },
      {
        Authorization: "Bearer atb_test",
        "Idempotency-Key": "codex/activity/oversized",
        "X-AI-Session-ID": sessionId,
      },
    );

    const response = await reportActivity(request);

    expect(response.status).toBe(413);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(routeMocks.authenticateAIRequest).toHaveBeenCalledWith(request);
    expect(routeMocks.authorizeAISession).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId, workspaceId }),
      sessionId,
    );
    expect(domainMocks.reportSessionActivity).not.toHaveBeenCalled();
  });

  it("rejects user-message injection after authenticating the Harness", async () => {
    const response = await reportActivity(
      jsonRequest(
        "/api/ai/sessions/activity",
        {
          task_id: taskId,
          claim_token: "claim_secret",
          kind: "user_message",
          content: "forged user message",
          external_ref: "codex:item:forged",
        },
        {
          Authorization: "Bearer atb_test",
          "Idempotency-Key": "codex/activity/forged",
          "X-AI-Session-ID": sessionId,
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(routeMocks.authenticateAIRequest).toHaveBeenCalledOnce();
    expect(routeMocks.authorizeAISession).toHaveBeenCalledOnce();
    expect(domainMocks.reportSessionActivity).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";

const aiContext = {
  workspaceId,
  connectionId,
  sessionId,
  tokenHash: "connection-token-hash",
};
const userContext = { workspaceId, userId, role: "member" as const };

const domainMocks = vi.hoisted(() => ({
  registerTaskUserInputRequest: vi.fn(),
  pollTaskUserInputRequest: vi.fn(),
  answerTaskUserInputRequest: vi.fn(),
}));
const routeMocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  authorizeAISession: vi.fn(),
  userContextForRequest: vi.fn(),
}));

vi.mock("@/lib/domain/tasks", () => ({
  registerTaskUserInputRequest: domainMocks.registerTaskUserInputRequest,
  pollTaskUserInputRequest: domainMocks.pollTaskUserInputRequest,
}));
vi.mock("@/lib/domain/users", () => ({
  answerTaskUserInputRequest: domainMocks.answerTaskUserInputRequest,
}));
vi.mock("@/lib/auth/ai-auth", () => ({
  authenticateAIRequest: routeMocks.authenticateAIRequest,
  authorizeAISession: routeMocks.authorizeAISession,
  sessionIdFromRequest: (request: Request) =>
    request.headers.get("x-ai-session-id")?.trim() ?? "",
}));
vi.mock("@/lib/http/user-route", () => ({
  userContextForRequest: routeMocks.userContextForRequest,
}));

import { POST as registerRequest } from "@/app/api/ai/tasks/user-input-requests/route";
import { POST as pollRequest } from "@/app/api/ai/tasks/user-input-requests/[requestId]/poll/route";
import { POST as answerRequest } from "@/app/api/user/tasks/[taskId]/input-requests/[requestId]/answer/route";

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

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.authenticateAIRequest.mockResolvedValue({
    workspaceId,
    connectionId,
    tokenHash: aiContext.tokenHash,
  });
  routeMocks.authorizeAISession.mockResolvedValue(aiContext);
  routeMocks.userContextForRequest.mockResolvedValue(userContext);
  domainMocks.registerTaskUserInputRequest.mockResolvedValue({
    request: { id: requestId, status: "pending" },
  });
  domainMocks.pollTaskUserInputRequest.mockResolvedValue({
    request: { id: requestId, status: "pending", answers: null },
  });
  domainMocks.answerTaskUserInputRequest.mockResolvedValue({
    request: { id: requestId, status: "answered" },
  });
});

describe("structured user input REST API", () => {
  const claimed = { task_id: taskId, claim_token: "claim_secret" };

  it("registers normalized App Server questions under the active AI session", async () => {
    const request = jsonRequest(
      "/api/ai/tasks/user-input-requests",
      {
        ...claimed,
        request_id: requestId,
        external_request_id: "app-request-1",
        turn_id: "turn-1",
        item_id: "item-1",
        is_blocking: true,
        questions: [
          {
            id: "choice",
            header: "方式",
            question: "请选择",
            options: [{ label: "A", description: "方案 A" }],
          },
        ],
      },
      {
        "X-AI-Session-ID": sessionId,
        "Idempotency-Key": "bridge/input/register-1",
      },
    );
    const response = await registerRequest(request);

    expect(response.status).toBe(200);
    expect(domainMocks.registerTaskUserInputRequest).toHaveBeenCalledWith(
      aiContext,
      expect.objectContaining({
        request_id: requestId,
        is_blocking: true,
        questions: [
          expect.objectContaining({
            id: "choice",
            isOther: false,
            isSecret: false,
          }),
        ],
      }),
      "bridge/input/register-1",
    );
  });

  it("polls without requiring an idempotency key", async () => {
    const request = jsonRequest(
      `/api/ai/tasks/user-input-requests/${requestId}/poll`,
      { ...claimed, request_id: requestId },
      { "X-AI-Session-ID": sessionId },
    );
    const response = await pollRequest(request, {
      params: Promise.resolve({ requestId }),
    });

    expect(response.status).toBe(200);
    expect(domainMocks.pollTaskUserInputRequest).toHaveBeenCalledWith(
      aiContext,
      { ...claimed, request_id: requestId },
    );
  });

  it("submits one answer per question as the authenticated Workspace user", async () => {
    const answers = { choice: ["A"] };
    const request = jsonRequest(
      `/api/user/tasks/${taskId}/input-requests/${requestId}/answer`,
      { answers },
      { "Idempotency-Key": "web/input/answer-1" },
    );
    const response = await answerRequest(request, {
      params: Promise.resolve({ taskId, requestId }),
    });

    expect(response.status).toBe(200);
    expect(domainMocks.answerTaskUserInputRequest).toHaveBeenCalledWith(
      userContext,
      taskId,
      requestId,
      { answers },
      "web/input/answer-1",
    );
  });

  it("rejects an empty answer map before calling the domain", async () => {
    const response = await answerRequest(
      jsonRequest(
        `/api/user/tasks/${taskId}/input-requests/${requestId}/answer`,
        { answers: {} },
        { "Idempotency-Key": "web/input/answer-empty" },
      ),
      { params: Promise.resolve({ taskId, requestId }) },
    );

    expect(response.status).toBe(400);
    expect(domainMocks.answerTaskUserInputRequest).not.toHaveBeenCalled();
  });
});

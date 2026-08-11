import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const commandId = "44444444-4444-4444-8444-444444444444";
const runtimeId = "55555555-5555-4555-8555-555555555555";

const domainMocks = vi.hoisted(() => ({
  renameConnection: vi.fn(),
  createThread: vi.fn(),
  claimThreadCommand: vi.fn(),
  completeThreadCommand: vi.fn(),
}));
const routeMocks = vi.hoisted(() => ({
  ownerContextForRequest: vi.fn(),
  authenticateAIRequest: vi.fn(),
}));

vi.mock("@/lib/domain/users", () => ({
  renameConnection: domainMocks.renameConnection,
  createThread: domainMocks.createThread,
}));
vi.mock("@/lib/domain/thread-management", () => ({
  claimThreadCommand: domainMocks.claimThreadCommand,
  completeThreadCommand: domainMocks.completeThreadCommand,
}));
vi.mock("@/lib/http/user-route", () => ({
  ownerContextForRequest: routeMocks.ownerContextForRequest,
}));
vi.mock("@/lib/auth/ai-auth", () => ({
  authenticateAIRequest: routeMocks.authenticateAIRequest,
}));

import { POST as claimCommand } from "@/app/api/ai/thread-commands/claim/route";
import { POST as completeCommand } from "@/app/api/ai/thread-commands/[commandId]/complete/route";
import { PATCH as renameConnection } from "@/app/api/user/connections/[connectionId]/route";
import { POST as createThread } from "@/app/api/user/connections/[connectionId]/threads/route";

function jsonRequest(pathname: string, body: unknown, idempotencyKey?: string) {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.ownerContextForRequest.mockResolvedValue({
    workspaceId,
    userId,
    role: "owner",
  });
  routeMocks.authenticateAIRequest.mockResolvedValue({
    workspaceId,
    connectionId,
    tokenHash: "token-hash",
  });
  domainMocks.renameConnection.mockResolvedValue({ connection: { connectionId } });
  domainMocks.createThread.mockResolvedValue({ command: { id: commandId } });
  domainMocks.claimThreadCommand.mockResolvedValue({ command: null });
  domainMocks.completeThreadCommand.mockResolvedValue({
    command: { id: commandId, status: "succeeded" },
  });
});

describe("Web Thread management REST API", () => {
  it("renames an AI connection with owner scope", async () => {
    const request = jsonRequest(
      `/api/user/connections/${connectionId}`,
      { name: "  Office Codex  " },
      "web/connection/rename-1",
    );
    const response = await renameConnection(request, {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(200);
    expect(domainMocks.renameConnection).toHaveBeenCalledWith(
      expect.objectContaining({ role: "owner" }),
      connectionId,
      { name: "Office Codex" },
      "web/connection/rename-1",
    );
  });

  it("queues creation against a validated connection", async () => {
    const request = jsonRequest(
      `/api/user/connections/${connectionId}/threads`,
      { name: "  New Thread  " },
      "web/thread/create-1",
    );
    const response = await createThread(request, {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(202);
    expect(domainMocks.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ role: "owner" }),
      connectionId,
      { name: "New Thread" },
      "web/thread/create-1",
    );
  });

  it("authenticates a Bridge before claiming its next command", async () => {
    const request = jsonRequest("/api/ai/thread-commands/claim", {
      runtime_instance_id: runtimeId,
      lease_seconds: 60,
    });
    const response = await claimCommand(request);

    expect(response.status).toBe(200);
    expect(routeMocks.authenticateAIRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.claimThreadCommand).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId }),
      { runtime_instance_id: runtimeId, lease_seconds: 60 },
    );
  });

  it("reports a successful local command result", async () => {
    const request = jsonRequest(
      `/api/ai/thread-commands/${commandId}/complete`,
      {
        runtime_instance_id: runtimeId,
        succeeded: true,
        external_thread_id: "local-thread-42",
        error: null,
      },
    );
    const response = await completeCommand(request, {
      params: Promise.resolve({ commandId }),
    });

    expect(response.status).toBe(200);
    expect(domainMocks.completeThreadCommand).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId }),
      commandId,
      {
        runtime_instance_id: runtimeId,
        succeeded: true,
        external_thread_id: "local-thread-42",
        error: null,
      },
    );
  });

  it("rejects a failed completion without a bounded error message", async () => {
    const response = await completeCommand(
      jsonRequest(`/api/ai/thread-commands/${commandId}/complete`, {
        runtime_instance_id: runtimeId,
        succeeded: false,
        error: null,
      }),
      { params: Promise.resolve({ commandId }) },
    );

    expect(response.status).toBe(400);
    expect(domainMocks.completeThreadCommand).not.toHaveBeenCalled();
  });
});

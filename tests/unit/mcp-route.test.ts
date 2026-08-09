import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authMocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(async () => ({
    connectionId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    tokenHash: "hash",
  })),
  authorizeAISession: vi.fn(async () => ({
    connectionId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    tokenHash: "hash",
    sessionId: "33333333-3333-4333-8333-333333333333",
  })),
}));

vi.mock("@/lib/auth/ai-auth", () => authMocks);

import { POST } from "@/app/api/mcp/route";

function mcpRequest(body: unknown): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer atb_test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  authMocks.authenticateAIRequest.mockClear();
  authMocks.authorizeAISession.mockClear();
});

describe("stateless MCP endpoint", () => {
  it("negotiates the documented protocol without issuing an MCP session", async () => {
    const response = await POST(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    );
    const payload = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(payload).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "ai-task-board", version: "0.1.0" },
      },
    });
    expect(authMocks.authenticateAIRequest).toHaveBeenCalledOnce();
  });

  it("publishes every required tool and its transport metadata", async () => {
    const response = await POST(
      mcpRequest({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} }),
    );
    const payload = await json(response);
    const result = payload.result as { tools: Array<Record<string, unknown>> };
    const byName = new Map(result.tools.map((tool) => [tool.name, tool]));

    expect([...byName.keys()]).toEqual([
      "register_session",
      "report_current_task",
      "claim_next_task",
      "claim_task",
      "get_task",
      "create_subtasks",
      "report_progress",
      "post_task_message",
      "request_user_input",
      "heartbeat_session",
      "heartbeat",
      "complete_task",
      "complete_task_and_claim_next",
      "fail_task",
      "release_task",
      "get_task_updates",
    ]);

    const registerSchema = byName.get("register_session")?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(registerSchema.required).toContain("idempotency_key");
    expect(registerSchema.properties).toHaveProperty("idempotency_key");
    expect(registerSchema.properties).not.toHaveProperty("session_id");

    const claimSchema = byName.get("claim_task")?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(claimSchema.required).toEqual(
      expect.arrayContaining(["task_id", "idempotency_key"]),
    );
    expect(claimSchema.properties).toHaveProperty("session_id");
    expect(claimSchema.additionalProperties).toBe(false);

    const getSchema = byName.get("get_task")?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(getSchema.required).toContain("task_id");
    expect(getSchema.required).not.toContain("idempotency_key");
    expect(getSchema.properties).toHaveProperty("session_id");
    expect(getSchema.properties).not.toHaveProperty("idempotency_key");
  });

  it("acknowledges initialized notifications without JSON state", async () => {
    const response = await POST(
      mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("returns a standard JSON-RPC parse error before authentication", async () => {
    const response = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer atb_test" },
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(authMocks.authenticateAIRequest).not.toHaveBeenCalled();
  });
});

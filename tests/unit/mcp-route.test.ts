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
    const instructions = (payload.result as { instructions: string }).instructions;
    const firstParagraph = instructions.split("\n\n", 1)[0];
    expect(firstParagraph.length).toBeLessThanOrEqual(512);
    expect(firstParagraph).toContain("register_session");
    expect(firstParagraph).toContain("Every 60s");
    expect(firstParagraph).toContain("heartbeat_session");
    expect(firstParagraph).toContain("waiting for user input");
    expect(firstParagraph).toContain("also call heartbeat");
    expect(firstParagraph).toContain("explicit user request");
    expect(firstParagraph).toContain("conversation end");
    expect(instructions).toContain("session heartbeat does not renew task leases");
    expect(instructions).toContain("call release_task");
    expect(instructions).toContain("do not start an external daemon");
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
      "report_session_activity",
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

    expect(byName.get("register_session")?.description).toContain("every 60 seconds");
    expect(byName.get("heartbeat_session")?.description).toContain(
      "does not renew task claims",
    );
    expect(byName.get("heartbeat")?.description).toContain(
      "in addition to heartbeat_session",
    );

    const sessionHeartbeatSchema = byName.get("heartbeat_session")?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(sessionHeartbeatSchema.required).toContain("idempotency_key");
    expect(sessionHeartbeatSchema.properties).toHaveProperty("session_id");
    expect(sessionHeartbeatSchema.properties).not.toHaveProperty("task_id");
    expect(sessionHeartbeatSchema.properties).not.toHaveProperty("claim_token");

    const taskHeartbeatSchema = byName.get("heartbeat")?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(taskHeartbeatSchema.required).toEqual(
      expect.arrayContaining(["idempotency_key", "task_id", "claim_token"]),
    );
    expect(taskHeartbeatSchema.properties).toHaveProperty("session_id");
    expect(taskHeartbeatSchema.properties).toHaveProperty("lease_seconds");

    const activitySchema = byName.get("report_session_activity")?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(activitySchema.required).toEqual(
      expect.arrayContaining([
        "task_id",
        "claim_token",
        "kind",
        "external_ref",
        "idempotency_key",
      ]),
    );
    expect(activitySchema.properties).toHaveProperty("session_id");
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

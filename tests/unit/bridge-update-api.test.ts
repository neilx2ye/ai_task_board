import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const ownerContext = { role: "owner" as const, userId, workspaceId };

const domainMocks = vi.hoisted(() => ({
  setBridgeUpdateTarget: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  ownerContextForRequest: vi.fn(),
}));

vi.mock("@/lib/domain/bridge-update", () => ({
  setBridgeUpdateTarget: domainMocks.setBridgeUpdateTarget,
}));
vi.mock("@/lib/http/user-route", () => ({
  ownerContextForRequest: authMocks.ownerContextForRequest,
}));

import { POST as setBridgeUpdate } from "@/app/api/user/connections/[connectionId]/bridge-update/route";
import { AppError } from "@/lib/domain/errors";

function jsonRequest(
  connection: string,
  body: unknown,
  options: { headers?: Record<string, string> } = {},
) {
  return new Request(
    `http://localhost/api/user/connections/${connection}/bridge-update`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify(body),
    },
  );
}

const routeContext = (connection: string) => ({
  params: Promise.resolve({ connectionId: connection }),
});

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.ownerContextForRequest.mockResolvedValue(ownerContext);
  domainMocks.setBridgeUpdateTarget.mockResolvedValue({
    desired_bridge_version: "1.4.0",
  });
});

describe("bridge-update API", () => {
  it("把校验通过的输入交给 owner-only 领域层", async () => {
    const request = jsonRequest(connectionId, { target_version: "1.4.0" }, {
      headers: { "Idempotency-Key": " web/bridge-update/1 " },
    });
    const response = await setBridgeUpdate(request, routeContext(connectionId));

    expect(response.status).toBe(200);
    expect(authMocks.ownerContextForRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.setBridgeUpdateTarget).toHaveBeenCalledWith(
      ownerContext,
      connectionId,
      { target_version: "1.4.0" },
    );
    expect(await response.json()).toEqual({
      data: { desired_bridge_version: "1.4.0" },
    });
  });

  it("target_version 为 null 时表示取消待升级", async () => {
    domainMocks.setBridgeUpdateTarget.mockResolvedValue({
      desired_bridge_version: null,
    });
    const response = await setBridgeUpdate(
      jsonRequest(connectionId, { target_version: null }, {
        headers: { "Idempotency-Key": "web/bridge-update/cancel" },
      }),
      routeContext(connectionId),
    );

    expect(response.status).toBe(200);
    expect(domainMocks.setBridgeUpdateTarget).toHaveBeenCalledWith(
      ownerContext,
      connectionId,
      { target_version: null },
    );
  });

  it("要求 Idempotency-Key", async () => {
    const response = await setBridgeUpdate(
      jsonRequest(connectionId, { target_version: "1.4.0" }),
      routeContext(connectionId),
    );

    expect(response.status).toBe(400);
    expect(domainMocks.setBridgeUpdateTarget).not.toHaveBeenCalled();
  });

  it("拒绝非法连接 id 与非法版本负载", async () => {
    const invalidParams = await setBridgeUpdate(
      jsonRequest("not-a-uuid", { target_version: "1.4.0" }, {
        headers: { "Idempotency-Key": "web/bridge-update/bad-id" },
      }),
      routeContext("not-a-uuid"),
    );
    expect(invalidParams.status).toBe(400);

    for (const body of [
      {},
      { target_version: "" },
      { target_version: 123 },
      { target_version: "x".repeat(51) },
    ]) {
      const response = await setBridgeUpdate(
        jsonRequest(connectionId, body, {
          headers: { "Idempotency-Key": "web/bridge-update/bad-body" },
        }),
        routeContext(connectionId),
      );
      expect(response.status).toBe(400);
    }
    expect(domainMocks.setBridgeUpdateTarget).not.toHaveBeenCalled();
  });

  it("非 owner 访问映射为 403", async () => {
    authMocks.ownerContextForRequest.mockRejectedValue(
      new AppError("FORBIDDEN", "Workspace owner access is required"),
    );

    const response = await setBridgeUpdate(
      jsonRequest(connectionId, { target_version: "1.4.0" }, {
        headers: { "Idempotency-Key": "web/bridge-update/forbidden" },
      }),
      routeContext(connectionId),
    );

    expect(response.status).toBe(403);
    expect(domainMocks.setBridgeUpdateTarget).not.toHaveBeenCalled();
  });
});

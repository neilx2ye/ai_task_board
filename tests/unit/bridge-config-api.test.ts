import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const runtimeInstanceId = "44444444-4444-4444-8444-444444444444";
const ownerContext = { role: "owner" as const, userId, workspaceId };
const aiContext = {
  connectionId,
  tokenHash: "bridge-token-hash",
  workspaceId,
};

const configuration = {
  configuration: {
    connection_id: connectionId,
    version: 3,
    desired: {
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: null,
    },
    applied: null,
    runtime: { online: false, lease_expires_at: null },
    updated_at: "2026-08-10T00:00:00.000Z",
  },
};

const domainMocks = vi.hoisted(() => ({
  exchangeBridgeConfiguration: vi.fn(),
  getBridgeConfiguration: vi.fn(),
  updateBridgeConfiguration: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  ownerContextForRequest: vi.fn(),
}));

vi.mock("@/lib/domain/bridge-config", () => ({
  exchangeBridgeConfiguration: domainMocks.exchangeBridgeConfiguration,
  getBridgeConfiguration: domainMocks.getBridgeConfiguration,
  updateBridgeConfiguration: domainMocks.updateBridgeConfiguration,
}));
vi.mock("@/lib/auth/ai-auth", () => ({
  authenticateAIRequest: authMocks.authenticateAIRequest,
}));
vi.mock("@/lib/http/user-route", () => ({
  ownerContextForRequest: authMocks.ownerContextForRequest,
}));

import { POST as exchangeConfig } from "@/app/api/ai/config/route";
import {
  GET as getConfig,
  PATCH as updateConfig,
} from "@/app/api/user/connections/[connectionId]/bridge-config/route";
import { AppError } from "@/lib/domain/errors";
import { BRIDGE_CONFIG_BODY_LIMIT_BYTES } from "@/lib/validation/bridge-config";

function jsonRequest(
  pathname: string,
  body: unknown,
  options: {
    method?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return new Request(`http://localhost${pathname}`, {
    method: options.method ?? "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.ownerContextForRequest.mockResolvedValue(ownerContext);
  authMocks.authenticateAIRequest.mockResolvedValue(aiContext);
  domainMocks.getBridgeConfiguration.mockResolvedValue(configuration);
  domainMocks.updateBridgeConfiguration.mockResolvedValue(configuration);
  domainMocks.exchangeBridgeConfiguration.mockResolvedValue(configuration);
});

describe("owner Bridge configuration API", () => {
  it("loads one validated connection through the owner-only data layer", async () => {
    const request = new Request(
      `http://localhost/api/user/connections/${connectionId}/bridge-config`,
    );
    const response = await getConfig(request, {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(authMocks.ownerContextForRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.getBridgeConfiguration).toHaveBeenCalledWith(
      ownerContext,
      connectionId,
    );
    expect(await responseJson(response)).toEqual({ data: configuration });
  });

  it("requires a full desired state, expected version and idempotency key", async () => {
    const request = jsonRequest(
      `/api/user/connections/${connectionId}/bridge-config`,
      {
        expected_version: 3,
        enabled: false,
        include_thread_titles: true,
        max_threads: 80,
        max_concurrent_turns: 4,
        sync_history: true,
        history_turn_limit: 75,
        working_directories: [
          {
            directory_key: "main",
            name: "Main project",
            working_directory: "/srv/main",
          },
          {
            directory_key: "docs",
            name: "Docs",
            working_directory: "/srv/docs",
          },
        ],
      },
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "  web/bridge-config/3  " },
      },
    );
    const response = await updateConfig(request, {
      params: Promise.resolve({ connectionId }),
    });

    expect(response.status).toBe(200);
    expect(domainMocks.updateBridgeConfiguration).toHaveBeenCalledWith(
      ownerContext,
      connectionId,
      {
        expected_version: 3,
        enabled: false,
        include_thread_titles: true,
        max_threads: 80,
        max_concurrent_turns: 4,
        sync_history: true,
        history_turn_limit: 75,
        working_directories: [
          {
            directory_key: "main",
            name: "Main project",
            working_directory: "/srv/main",
          },
          {
            directory_key: "docs",
            name: "Docs",
            working_directory: "/srv/docs",
          },
        ],
      },
      "web/bridge-config/3",
    );
  });

  it.each([
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 0,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: null,
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 33,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: null,
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: [],
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: [
        {
          directory_key: "same",
          name: "Main",
          working_directory: "/srv/main",
        },
        {
          directory_key: "same",
          name: "Docs",
          working_directory: "/srv/docs",
        },
      ],
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: [
        {
          directory_key: "main",
          name: "Main",
          working_directory: "/srv/shared",
        },
        {
          directory_key: "docs",
          name: "Docs",
          working_directory: "/srv/shared",
        },
      ],
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: [
        {
          directory_key: "../escape",
          name: "Invalid key",
          working_directory: "/srv/main",
        },
      ],
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: [
        {
          directory_key: "main",
          name: "Main",
          working_directory: "/srv/main",
          unexpected: true,
        },
      ],
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: [
        {
          directory_key: "main",
          name: "n".repeat(201),
          working_directory: "/srv/main",
        },
      ],
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: [
        {
          directory_key: "main",
          name: "Main",
          working_directory: `/${"p".repeat(4096)}`,
        },
      ],
    },
    {
      expected_version: 3,
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: null,
      unexpected: true,
    },
  ])("rejects an invalid desired configuration %#", async (body) => {
    const response = await updateConfig(
      jsonRequest(
        `/api/user/connections/${connectionId}/bridge-config`,
        body,
        {
          method: "PATCH",
          headers: { "Idempotency-Key": "web/bridge-config/invalid" },
        },
      ),
      { params: Promise.resolve({ connectionId }) },
    );

    expect(response.status).toBe(400);
    expect(domainMocks.updateBridgeConfiguration).not.toHaveBeenCalled();
    expect(authMocks.ownerContextForRequest).not.toHaveBeenCalled();
  });

  it("returns a stable 409 error for an optimistic version conflict", async () => {
    domainMocks.updateBridgeConfiguration.mockRejectedValueOnce(
      new AppError(
        "VERSION_CONFLICT",
        "The configuration was changed by another request",
      ),
    );
    const response = await updateConfig(
      jsonRequest(
        `/api/user/connections/${connectionId}/bridge-config`,
        {
          expected_version: 2,
          enabled: true,
          include_thread_titles: false,
          max_threads: 50,
          max_concurrent_turns: 2,
          sync_history: false,
          history_turn_limit: 50,
          working_directories: null,
        },
        {
          method: "PATCH",
          headers: { "Idempotency-Key": "web/bridge-config/conflict" },
        },
      ),
      { params: Promise.resolve({ connectionId }) },
    );

    expect(response.status).toBe(409);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "VERSION_CONFLICT" },
    });
  });

  it("rejects an invalid path before attempting owner lookup", async () => {
    const response = await getConfig(
      new Request(
        "http://localhost/api/user/connections/not-a-uuid/bridge-config",
      ),
      { params: Promise.resolve({ connectionId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    expect(authMocks.ownerContextForRequest).not.toHaveBeenCalled();
    expect(domainMocks.getBridgeConfiguration).not.toHaveBeenCalled();
  });
});

describe("AI Bridge configuration exchange API", () => {
  const constraints = {
    remote_configuration_enabled: true,
    allow_thread_titles: false,
    max_threads: 50,
    max_concurrent_turns: 2,
    thread_scope: "cwd" as const,
    working_directory: "/srv/ai-task-board",
    fixed_thread: false,
    permission_mode: "safe" as const,
    approval_mode: "decline" as const,
  };

  it("accepts a first status report without an idempotency header", async () => {
    const request = jsonRequest(
      "/api/ai/config",
      {
        runtime_instance_id: runtimeInstanceId,
        report_sequence: 1,
        lease_seconds: 60,
        applied_version: null,
        effective: null,
        constraints,
        error: null,
      },
      { headers: { Authorization: "Bearer atb_test" } },
    );
    const response = await exchangeConfig(request);

    expect(response.status).toBe(200);
    expect(authMocks.authenticateAIRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.exchangeBridgeConfiguration).toHaveBeenCalledWith(
      aiContext,
      {
        runtime_instance_id: runtimeInstanceId,
        report_sequence: 1,
        lease_seconds: 60,
        release_runtime: false,
        applied_version: null,
        effective: null,
        constraints: {
          ...constraints,
          allow_history_sync: false,
          max_history_turns: 50,
          allow_working_directory_configuration: false,
        },
        error: null,
      },
    );
    expect(await responseJson(response)).toEqual({ data: configuration });
  });

  it("accepts a concrete effective directory report even when Web management is locally disabled", async () => {
    const workingDirectories = [
      {
        directory_key: "main",
        name: "Main project",
        working_directory: "/srv/main",
      },
    ];
    const request = jsonRequest(
      "/api/ai/config",
      {
        runtime_instance_id: runtimeInstanceId,
        report_sequence: 2,
        lease_seconds: 60,
        applied_version: 3,
        effective: {
          enabled: true,
          include_thread_titles: false,
          max_threads: 50,
          max_concurrent_turns: 2,
          working_directories: workingDirectories,
        },
        constraints: {
          ...constraints,
          allow_working_directory_configuration: false,
        },
        error: null,
      },
      { headers: { Authorization: "Bearer atb_test" } },
    );
    const response = await exchangeConfig(request);

    expect(response.status).toBe(200);
    expect(domainMocks.exchangeBridgeConfiguration).toHaveBeenCalledWith(
      aiContext,
      {
        runtime_instance_id: runtimeInstanceId,
        report_sequence: 2,
        lease_seconds: 60,
        release_runtime: false,
        applied_version: 3,
        effective: {
          enabled: true,
          include_thread_titles: false,
          max_threads: 50,
          max_concurrent_turns: 2,
          sync_history: false,
          history_turn_limit: 50,
          working_directories: workingDirectories,
        },
        constraints: {
          ...constraints,
          allow_history_sync: false,
          max_history_turns: 50,
          allow_working_directory_configuration: false,
        },
        error: null,
      },
    );
  });

  it("authenticates before consuming a malformed body", async () => {
    authMocks.authenticateAIRequest.mockRejectedValueOnce(
      new AppError("AUTHENTICATION_REQUIRED", "invalid token"),
    );
    const request = new Request("http://localhost/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await exchangeConfig(request);

    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(domainMocks.exchangeBridgeConfiguration).not.toHaveBeenCalled();
  });

  it.each([
    { runtime_instance_id: "not-a-uuid" },
    { report_sequence: 0 },
    { report_sequence: Number.MAX_SAFE_INTEGER + 1 },
    { lease_seconds: 14 },
    { lease_seconds: 1801 },
    { release_runtime: "false" },
  ])("rejects an invalid runtime fence %#", async (override) => {
    const response = await exchangeConfig(
      jsonRequest(
        "/api/ai/config",
        {
          runtime_instance_id: runtimeInstanceId,
          report_sequence: 1,
          lease_seconds: 60,
          release_runtime: false,
          applied_version: null,
          effective: null,
          constraints,
          error: null,
          ...override,
        },
        { headers: { Authorization: "Bearer atb_test" } },
      ),
    );

    expect(response.status).toBe(400);
    expect(domainMocks.exchangeBridgeConfiguration).not.toHaveBeenCalled();
  });

  it("rejects nested unknown fields and impossible effective limits", async () => {
    const response = await exchangeConfig(
      jsonRequest(
        "/api/ai/config",
        {
          runtime_instance_id: runtimeInstanceId,
          report_sequence: 2,
          lease_seconds: 60,
          applied_version: 3,
          effective: {
            enabled: true,
            include_thread_titles: false,
            max_threads: 501,
            max_concurrent_turns: 2,
          },
          constraints: { ...constraints, unexpected: true },
          error: null,
        },
        { headers: { Authorization: "Bearer atb_test" } },
      ),
    );

    expect(response.status).toBe(400);
    expect(authMocks.authenticateAIRequest).toHaveBeenCalledOnce();
    expect(domainMocks.exchangeBridgeConfiguration).not.toHaveBeenCalled();
  });

  it.each([
    {
      effective: {
        enabled: true,
        include_thread_titles: false,
        max_threads: 50,
        max_concurrent_turns: 3,
      },
      constraints: { ...constraints, max_concurrent_turns: 2 },
    },
    {
      effective: {
        enabled: true,
        include_thread_titles: true,
        max_threads: 50,
        max_concurrent_turns: 2,
      },
      constraints: { ...constraints, allow_thread_titles: false },
    },
  ])("rejects an effective state outside its local envelope %#", async (state) => {
    const response = await exchangeConfig(
      jsonRequest(
        "/api/ai/config",
        {
          runtime_instance_id: runtimeInstanceId,
          report_sequence: 2,
          lease_seconds: 60,
          applied_version: 3,
          ...state,
          error: null,
        },
        { headers: { Authorization: "Bearer atb_test" } },
      ),
    );

    expect(response.status).toBe(400);
    expect(domainMocks.exchangeBridgeConfiguration).not.toHaveBeenCalled();
  });

  it("returns 409 when another Bridge runtime holds the configuration lease", async () => {
    domainMocks.exchangeBridgeConfiguration.mockRejectedValueOnce(
      new AppError(
        "BRIDGE_INSTANCE_CONFLICT",
        "Another Bridge runtime is active for this connection",
      ),
    );
    const response = await exchangeConfig(
      jsonRequest(
        "/api/ai/config",
        {
          runtime_instance_id: runtimeInstanceId,
          report_sequence: 2,
          lease_seconds: 60,
          applied_version: null,
          effective: null,
          constraints,
          error: null,
        },
        { headers: { Authorization: "Bearer atb_test" } },
      ),
    );

    expect(response.status).toBe(409);
    expect(await responseJson(response)).toMatchObject({
      error: { code: "BRIDGE_INSTANCE_CONFLICT" },
    });
  });

  it("rejects an oversized report after authenticating", async () => {
    const request = jsonRequest(
      "/api/ai/config",
      {
        runtime_instance_id: runtimeInstanceId,
        report_sequence: 3,
        lease_seconds: 60,
        applied_version: null,
        effective: null,
        constraints,
        error: null,
      },
      {
        headers: {
          Authorization: "Bearer atb_test",
          "Content-Length": String(BRIDGE_CONFIG_BODY_LIMIT_BYTES + 1),
        },
      },
    );
    const response = await exchangeConfig(request);

    expect(response.status).toBe(413);
    expect(authMocks.authenticateAIRequest).toHaveBeenCalledWith(request);
    expect(domainMocks.exchangeBridgeConfiguration).not.toHaveBeenCalled();
  });
});

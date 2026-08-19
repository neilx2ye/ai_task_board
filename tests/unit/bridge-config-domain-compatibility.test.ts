import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpcMocks = vi.hoisted(() => ({
  callDomainRpc: vi.fn(),
}));
const databaseMocks = vi.hoisted(() => {
  const connectionQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    maybeSingle: vi.fn(),
  };
  const settingsQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  return {
    connectionQuery,
    from: vi.fn(),
    rpc: vi.fn(),
    settingsQuery,
  };
});

vi.mock("@/lib/domain/rpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/domain/rpc")>();
  return { ...original, callDomainRpc: rpcMocks.callDomainRpc };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: databaseMocks.from,
    rpc: databaseMocks.rpc,
  }),
}));

import {
  exchangeBridgeConfiguration,
  getBridgeConfiguration,
  updateBridgeConfiguration,
} from "@/lib/domain/bridge-config";
import { AppError } from "@/lib/domain/errors";

const auth = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  tokenHash: "connection-token-hash",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  platform: "codex",
};
const ownerContext = {
  role: "owner" as const,
  userId: "44444444-4444-4444-8444-444444444444",
  workspaceId: auth.workspaceId,
};
const input = {
  runtime_instance_id: "33333333-3333-4333-8333-333333333333",
  report_sequence: 1,
  lease_seconds: 30,
  release_runtime: false,
  applied_version: null,
  effective: {
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
      },
    ],
  },
  constraints: {
    remote_configuration_enabled: true,
    allow_thread_titles: false,
    max_threads: 50,
    max_concurrent_turns: 2,
    thread_scope: "cwd" as const,
    working_directory: "/srv/main",
    fixed_thread: false,
    permission_mode: "safe" as const,
    approval_mode: "decline" as const,
    allow_history_sync: false,
    max_history_turns: 50,
    allow_working_directory_configuration: false,
  },
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AI_TOKEN_PEPPER", "test-only-pepper-with-at-least-32-characters");
  databaseMocks.connectionQuery.select.mockReturnValue(
    databaseMocks.connectionQuery,
  );
  databaseMocks.connectionQuery.eq.mockReturnValue(
    databaseMocks.connectionQuery,
  );
  databaseMocks.connectionQuery.is.mockReturnValue(
    databaseMocks.connectionQuery,
  );
  databaseMocks.connectionQuery.maybeSingle.mockResolvedValue({
    data: { id: auth.connectionId },
    error: null,
  });
  databaseMocks.settingsQuery.select.mockReturnValue(
    databaseMocks.settingsQuery,
  );
  databaseMocks.settingsQuery.eq.mockReturnValue(databaseMocks.settingsQuery);
  // attachDesiredBridgeVersion 的旁挂读取：默认无待升级目标。
  databaseMocks.settingsQuery.maybeSingle.mockResolvedValue({
    data: { desired_bridge_version: null },
    error: null,
  });
  databaseMocks.from.mockImplementation((table: string) =>
    table === "ai_connections"
      ? databaseMocks.connectionQuery
      : databaseMocks.settingsQuery,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Bridge configuration migration compatibility", () => {
  it("retries an old configuration RPC without 0.8 directory status fields", async () => {
    const response = { configuration: { version: 5 } };
    rpcMocks.callDomainRpc
      .mockRejectedValueOnce(
        new AppError("INVALID_REQUEST", "The request contains invalid data"),
      )
      .mockResolvedValueOnce(response);

    // 注入 desired_bridge_version 后返回新对象，不再与 RPC 响应同引用。
    await expect(exchangeBridgeConfiguration(auth, input)).resolves.toEqual({
      configuration: { version: 5, desired_bridge_version: null },
    });

    expect(rpcMocks.callDomainRpc).toHaveBeenCalledTimes(2);
    expect(rpcMocks.callDomainRpc.mock.calls[0]?.[1]).toMatchObject({
      p_effective: expect.objectContaining({
        working_directories: input.effective.working_directories,
      }),
      p_constraints: expect.objectContaining({
        allow_working_directory_configuration: false,
      }),
    });
    expect(rpcMocks.callDomainRpc.mock.calls[1]?.[1]).toMatchObject({
      p_effective: expect.not.objectContaining({
        working_directories: expect.anything(),
      }),
      p_constraints: expect.not.objectContaining({
        allow_working_directory_configuration: expect.anything(),
      }),
    });
  });

  it("does not retry an authorization failure", async () => {
    rpcMocks.callDomainRpc.mockRejectedValue(
      new AppError("SESSION_NOT_AUTHORIZED", "Not authorized"),
    );

    await expect(exchangeBridgeConfiguration(auth, input)).rejects.toMatchObject({
      code: "SESSION_NOT_AUTHORIZED",
    });
    expect(rpcMocks.callDomainRpc).toHaveBeenCalledOnce();
  });

  it("normalizes a legacy settings row when the 0.8 columns are missing", async () => {
    const legacyRow = {
      connection_id: auth.connectionId,
      workspace_id: auth.workspaceId,
      version: 5,
      desired_enabled: true,
      desired_include_thread_titles: false,
      desired_max_threads: 50,
      desired_max_concurrent_turns: 2,
      desired_sync_history: false,
      desired_history_turn_limit: 50,
      applied_version: 5,
      effective_enabled: true,
      effective_include_thread_titles: false,
      effective_max_threads: 50,
      effective_max_concurrent_turns: 2,
      effective_sync_history: false,
      effective_history_turn_limit: 50,
      constraint_remote_configuration_enabled: true,
      constraint_allow_thread_titles: false,
      constraint_max_threads: 50,
      constraint_max_concurrent_turns: 2,
      constraint_thread_scope: "cwd",
      constraint_working_directory: "/srv/main",
      constraint_fixed_thread: false,
      constraint_permission_mode: "safe",
      constraint_approval_mode: "decline",
      constraint_allow_history_sync: false,
      constraint_max_history_turns: 50,
      error: null,
      applied_at: "2026-08-11T00:00:00.000Z",
      active_runtime_instance_id: input.runtime_instance_id,
      active_runtime_last_sequence: 1,
      active_runtime_lease_expires_at: "2099-08-11T00:00:00.000Z",
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
    };
    databaseMocks.settingsQuery.maybeSingle
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST204",
          message:
            "Could not find the 'desired_working_directories' column in the schema cache",
        },
      })
      .mockResolvedValueOnce({ data: legacyRow, error: null });

    await expect(
      getBridgeConfiguration(ownerContext, auth.connectionId),
    ).resolves.toMatchObject({
      configuration: {
        desired: { working_directories: null },
        applied: {
          effective: { working_directories: null },
          constraints: {
            allow_working_directory_configuration: false,
          },
        },
      },
    });
    expect(databaseMocks.settingsQuery.select).toHaveBeenCalledTimes(2);
  });

  it("uses the legacy update overload only when no directory change is requested", async () => {
    const response = { configuration: { version: 6 } };
    databaseMocks.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message:
            "Could not find update_ai_connection_bridge_config with p_working_directories",
        },
      })
      .mockResolvedValueOnce({ data: response, error: null });

    await expect(
      updateBridgeConfiguration(
        ownerContext,
        auth.connectionId,
        "codex",
        {
          expected_version: 5,
          enabled: true,
          include_thread_titles: false,
          max_threads: 50,
          max_concurrent_turns: 2,
          sync_history: false,
          history_turn_limit: 50,
          working_directories: null,
        },
        "bridge-config/update/legacy",
      ),
    ).resolves.toBe(response);

    expect(databaseMocks.rpc).toHaveBeenCalledTimes(2);
    expect(databaseMocks.rpc.mock.calls[0]?.[1]).toHaveProperty(
      "p_working_directories",
      null,
    );
    expect(databaseMocks.rpc.mock.calls[1]?.[1]).not.toHaveProperty(
      "p_working_directories",
    );
  });

  it("does not discard a requested directory change on a legacy schema", async () => {
    databaseMocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message:
          "Could not find update_ai_connection_bridge_config with p_working_directories",
      },
    });

    await expect(
      updateBridgeConfiguration(
        ownerContext,
        auth.connectionId,
        "codex",
        {
          expected_version: 5,
          enabled: true,
          include_thread_titles: false,
          max_threads: 50,
          max_concurrent_turns: 2,
          sync_history: false,
          history_turn_limit: 50,
          working_directories: input.effective.working_directories,
        },
        "bridge-config/update/directories",
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
    expect(databaseMocks.rpc).toHaveBeenCalledOnce();
  });
});

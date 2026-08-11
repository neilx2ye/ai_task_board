import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpcMocks = vi.hoisted(() => ({
  callDomainRpc: vi.fn(),
}));

vi.mock("@/lib/domain/rpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/domain/rpc")>();
  return { ...original, callDomainRpc: rpcMocks.callDomainRpc };
});

import { exchangeBridgeConfiguration } from "@/lib/domain/bridge-config";
import { AppError } from "@/lib/domain/errors";

const auth = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  tokenHash: "connection-token-hash",
  workspaceId: "22222222-2222-4222-8222-222222222222",
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
});

describe("Bridge configuration migration compatibility", () => {
  it("retries an old configuration RPC without 0.8 directory status fields", async () => {
    const response = { configuration: { version: 5 } };
    rpcMocks.callDomainRpc
      .mockRejectedValueOnce(
        new AppError("INVALID_REQUEST", "The request contains invalid data"),
      )
      .mockResolvedValueOnce(response);

    await expect(exchangeBridgeConfiguration(auth, input)).resolves.toBe(
      response,
    );

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
});

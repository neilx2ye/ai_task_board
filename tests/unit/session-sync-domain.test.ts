import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const databaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
}));
const rpcMocks = vi.hoisted(() => ({
  callDomainRpc: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: databaseMocks.rpc,
    from: databaseMocks.from,
  }),
}));
vi.mock("@/lib/domain/rpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/domain/rpc")>();
  return { ...original, callDomainRpc: rpcMocks.callDomainRpc };
});

import { syncSessions } from "@/lib/domain/sessions";
import type { AIAuthContext } from "@/lib/types/domain";
import type { SyncSessionsInput } from "@/lib/validation/ai";

const auth: AIAuthContext = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  tokenHash: "connection-token-hash",
};
const input: SyncSessionsInput = {
  bridge_version: "0.8.0",
  directories: [
    {
      directory_key: "main",
      name: "Main",
      working_directory: "/srv/main",
    },
  ],
  threads: [
    {
      external_conversation_ref: "thread-1",
      name: "Thread one",
      platform: "codex",
      working_directory: "/srv/main",
      directory_key: "main",
      capabilities: [],
      archived: false,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  const updateQuery = {
    error: null,
    select: databaseMocks.select,
    update: databaseMocks.update,
    eq: databaseMocks.eq,
    maybeSingle: databaseMocks.maybeSingle,
  };
  databaseMocks.from.mockReturnValue(updateQuery);
  databaseMocks.select.mockReturnValue(updateQuery);
  databaseMocks.update.mockReturnValue(updateQuery);
  databaseMocks.eq.mockReturnValue(updateQuery);
  // 默认无待升级目标：clearSatisfiedBridgeUpdate 读到 null 后直接返回。
  databaseMocks.maybeSingle.mockResolvedValue({
    data: { desired_bridge_version: null },
    error: null,
  });
  vi.stubEnv("AI_TOKEN_PEPPER", "test-only-pepper-with-at-least-32-characters");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Session inventory migration compatibility", () => {
  it("uses the directory-aware inventory RPC when it is available", async () => {
    const result = { sessions: [{ id: "session-1" }] };
    databaseMocks.rpc.mockResolvedValue({ data: result, error: null });

    await expect(syncSessions(auth, input, "inventory/1")).resolves.toBe(result);

    expect(databaseMocks.rpc).toHaveBeenCalledWith(
      "sync_ai_sessions_with_directories",
      expect.objectContaining({
        p_directories: input.directories,
        p_threads: input.threads,
      }),
    );
    expect(rpcMocks.callDomainRpc).not.toHaveBeenCalled();
  });

  it("stores a reported model catalog only after inventory succeeds", async () => {
    const result = { sessions: [{ id: "session-1" }] };
    databaseMocks.rpc.mockResolvedValue({ data: result, error: null });
    const modelCatalog = [{
      id: "custom-fast",
      model: "provider/custom-fast",
      display_name: "Custom Fast",
      description: null,
      default_reasoning_effort: "balanced",
      supported_reasoning_efforts: [
        { reasoning_effort: "balanced", description: "Balanced" },
      ],
      input_modalities: ["text"],
      is_default: true,
    }];

    await expect(
      syncSessions(
        auth,
        { ...input, model_catalog: modelCatalog },
        "inventory/catalog",
      ),
    ).resolves.toBe(result);

    expect(databaseMocks.from).toHaveBeenCalledWith(
      "ai_connection_bridge_settings",
    );
    expect(databaseMocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        model_catalog: modelCatalog,
        model_catalog_updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
    expect(databaseMocks.eq).toHaveBeenCalledWith(
      "workspace_id",
      auth.workspaceId,
    );
    expect(databaseMocks.eq).toHaveBeenCalledWith(
      "connection_id",
      auth.connectionId,
    );
  });

  it.each(["PGRST202", "42883"])(
    "falls back to legacy inventory while the new RPC is missing (%s)",
    async (code) => {
      const result = { sessions: [{ id: "session-1" }] };
      databaseMocks.rpc.mockResolvedValue({
        data: null,
        error: {
          code,
          message:
            "Could not find the function public.sync_ai_sessions_with_directories in the schema cache",
        },
      });
      rpcMocks.callDomainRpc.mockResolvedValue(result);

      await expect(syncSessions(auth, input, "inventory/legacy")).resolves.toBe(
        result,
      );

      expect(rpcMocks.callDomainRpc).toHaveBeenCalledWith(
        "sync_ai_sessions",
        expect.objectContaining({
          p_bridge_version: "0.8.0",
          p_idempotency_key: "inventory/legacy",
          p_threads: [
            expect.not.objectContaining({ directory_key: expect.anything() }),
          ],
          p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
      expect(rpcMocks.callDomainRpc.mock.calls[0]?.[1]).toMatchObject({
        p_threads: [
          {
            external_conversation_ref: "thread-1",
            name: "Thread one",
            platform: "codex",
            working_directory: "/srv/main",
            capabilities: [],
            archived: false,
          },
        ],
      });
    },
  );

  it("does not hide unrelated directory inventory failures", async () => {
    databaseMocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "08006", message: "connection failure" },
    });

    await expect(syncSessions(auth, input, "inventory/failure")).rejects.toMatchObject(
      { code: "INTERNAL_ERROR", status: 500 },
    );
    expect(rpcMocks.callDomainRpc).not.toHaveBeenCalled();
  });
});

describe("Bridge update target clearing", () => {
  beforeEach(() => {
    databaseMocks.rpc.mockResolvedValue({
      data: { sessions: [] },
      error: null,
    });
  });

  it("clears the desired version once the reported version reaches it", async () => {
    databaseMocks.maybeSingle.mockResolvedValue({
      data: { desired_bridge_version: "1.4.0" },
      error: null,
    });

    await syncSessions(auth, { ...input, bridge_version: "1.4.0" }, "update/1");

    expect(databaseMocks.update).toHaveBeenCalledWith({
      desired_bridge_version: null,
    });
    expect(databaseMocks.eq).toHaveBeenCalledWith(
      "desired_bridge_version",
      "1.4.0",
    );
  });

  it("clears the desired version when the reported version is newer", async () => {
    databaseMocks.maybeSingle.mockResolvedValue({
      data: { desired_bridge_version: "1.4.0" },
      error: null,
    });

    await syncSessions(auth, { ...input, bridge_version: "1.5.2" }, "update/2");

    expect(databaseMocks.update).toHaveBeenCalledWith({
      desired_bridge_version: null,
    });
  });

  it("keeps the desired version while the reported version is still older", async () => {
    databaseMocks.maybeSingle.mockResolvedValue({
      data: { desired_bridge_version: "1.4.0" },
      error: null,
    });

    await syncSessions(auth, { ...input, bridge_version: "1.3.0" }, "update/3");

    expect(databaseMocks.update).not.toHaveBeenCalled();
  });

  it("does nothing when no update target is set", async () => {
    await syncSessions(auth, { ...input, bridge_version: "1.4.0" }, "update/4");

    expect(databaseMocks.update).not.toHaveBeenCalled();
  });
});

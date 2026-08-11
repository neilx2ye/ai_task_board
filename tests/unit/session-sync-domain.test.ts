import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const databaseMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));
const rpcMocks = vi.hoisted(() => ({
  callDomainRpc: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: databaseMocks.rpc }),
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

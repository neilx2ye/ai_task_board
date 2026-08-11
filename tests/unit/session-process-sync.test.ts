import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpcMocks = vi.hoisted(() => ({
  callDomainRpc: vi.fn(),
}));

vi.mock("@/lib/domain/rpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/domain/rpc")>();
  return { ...original, callDomainRpc: rpcMocks.callDomainRpc };
});

import { importSessionHistory } from "@/lib/domain/session-history";
import { reportSessionActivity } from "@/lib/domain/tasks";
import type { AISessionContext } from "@/lib/types/domain";
import type {
  ImportSessionHistoryInput,
  ReportSessionActivityInput,
} from "@/lib/validation/ai";

const context: AISessionContext = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  tokenHash: "connection-token-hash",
  workspaceId: "33333333-3333-4333-8333-333333333333",
};

const activity: ReportSessionActivityInput = {
  task_id: "44444444-4444-4444-8444-444444444444",
  claim_token: "claim-secret",
  kind: "reasoning",
  content: "Checked the implementation",
  data: {},
  external_ref: "codex:item:reasoning-1",
};

const history: ImportSessionHistoryInput = {
  runtime_instance_id: "55555555-5555-4555-8555-555555555555",
  report_sequence: 1,
  items: [
    {
      external_ref: "codex-history:user",
      kind: "user_message",
      content: "Please continue",
      occurred_at: "2026-08-11T10:00:00.000Z",
      source_order: 1,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        item_id: "user-1",
      },
    },
    {
      external_ref: "codex-history:reasoning",
      kind: "reasoning",
      content: "Internal summary",
      occurred_at: "2026-08-11T10:00:01.000Z",
      source_order: 2,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        item_id: "reasoning-1",
      },
    },
    {
      external_ref: "codex-history:assistant",
      kind: "assistant_message",
      content: "Done",
      occurred_at: "2026-08-11T10:00:02.000Z",
      source_order: 3,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        item_id: "assistant-1",
      },
    },
  ],
  sync: {
    status: "complete",
    turn_limit: 10,
    scanned_turns: 1,
    total_turns: 1,
    next_cursor: null,
    error: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AI_TOKEN_PEPPER", "test-only-pepper-with-at-least-32-characters");
  rpcMocks.callDomainRpc.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("message-only session synchronization", () => {
  it("always suppresses non-assistant live activity before any database call", async () => {
    await expect(
      reportSessionActivity(context, activity, "activity/reasoning-1"),
    ).resolves.toEqual({ activity: null, message: null, suppressed: true });
    expect(rpcMocks.callDomainRpc).not.toHaveBeenCalled();
  });

  it("stores assistant replies", async () => {
    await reportSessionActivity(
      context,
      {
        ...activity,
        kind: "assistant_message",
        content: "Finished",
        external_ref: "codex:item:assistant-1",
      },
      "activity/assistant-1",
    );

    expect(rpcMocks.callDomainRpc).toHaveBeenCalledWith(
      "report_session_activity",
      expect.objectContaining({
        p_kind: "assistant_message",
        p_content: "Finished",
      }),
    );
  });

  it("keeps user prompts and assistant replies in history batches", async () => {
    await importSessionHistory(context, history);

    expect(rpcMocks.callDomainRpc).toHaveBeenCalledWith(
      "import_session_history",
      expect.objectContaining({
        p_items: [history.items[0], history.items[2]],
      }),
    );
  });
});

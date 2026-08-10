import { describe, expect, it } from "vitest";

import {
  mergeSessionConversationPages,
  sessionConversationRecoveryInterval,
} from "@/hooks/use-sessions";
import type { SessionConversation } from "@/lib/types/domain";

function page(
  ids: string[],
  options: { hasMore?: boolean; truncated?: boolean } = {},
): SessionConversation {
  return {
    session: { id: "session-1" } as SessionConversation["session"],
    tasks: [],
    messages: [],
    events: [],
    activities: ids.map((id) => ({
      id,
      workspace_id: "workspace-1",
      session_id: "session-1",
      task_id: null,
      task_message_id: null,
      kind: "status",
      actor_type: "ai",
      content: id,
      data: {},
      external_ref: null,
      created_at: "2026-08-09T00:00:00.000Z",
    })),
    pagination: {
      activities: {
        limit: 2,
        oldest_cursor: ids[0] ?? null,
        newest_cursor: ids.at(-1) ?? null,
        has_more_older: options.hasMore ?? false,
      },
      legacy: {
        limit: 5000,
        tasks_truncated: options.truncated ?? false,
        messages_truncated: false,
        events_truncated: false,
      },
    },
  };
}

describe("session conversation pagination", () => {
  it("merges overlapping pages by exact bigint strings in chronological id order", () => {
    const merged = mergeSessionConversationPages([
      page(["9007199254740993124", "9007199254740993125"]),
      page(["9007199254740993122", "9007199254740993124"], {
        hasMore: true,
      }),
    ]);

    expect(merged?.activities.map((activity) => activity.id)).toEqual([
      "9007199254740993122",
      "9007199254740993124",
      "9007199254740993125",
    ]);
    expect(merged?.pagination.activities).toMatchObject({
      oldest_cursor: "9007199254740993122",
      newest_cursor: "9007199254740993125",
      has_more_older: true,
    });
  });

  it("retains explicit legacy truncation metadata across loaded pages", () => {
    const merged = mergeSessionConversationPages([
      page(["3", "4"], { truncated: true }),
      page(["1", "2"]),
    ]);

    expect(merged?.pagination.legacy.tasks_truncated).toBe(true);
  });

  it("does not periodically refetch every page after older history is loaded", () => {
    expect(sessionConversationRecoveryInterval(0)).toBe(30_000);
    expect(sessionConversationRecoveryInterval(1)).toBe(30_000);
    expect(sessionConversationRecoveryInterval(2)).toBe(false);
    expect(sessionConversationRecoveryInterval(20)).toBe(false);
  });
});

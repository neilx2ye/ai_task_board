import { describe, expect, it } from "vitest";

import {
  mergeSessionConversationPages,
  sessionConversationRecoveryInterval,
} from "@/hooks/use-sessions";
import type { SessionConversation } from "@/lib/types/domain";

function page(
  ids: string[],
  options: {
    hasMore?: boolean;
    truncated?: boolean;
    oldestCursor?: string | null;
    newestCursor?: string | null;
  } = {},
): SessionConversation {
  return {
    session: { id: "session-1" } as SessionConversation["session"],
    history_sync: null,
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
      occurred_at: "2026-08-09T00:00:00.000Z",
      source_order: id,
      source: "live",
    })),
    pagination: {
      activities: {
        limit: 2,
        oldest_cursor:
          options.oldestCursor === undefined
            ? `oldest:${ids[0] ?? "empty"}`
            : options.oldestCursor,
        newest_cursor:
          options.newestCursor === undefined
            ? `newest:${ids.at(-1) ?? "empty"}`
            : options.newestCursor,
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
  it("merges overlapping pages and preserves the API's opaque boundary cursors", () => {
    const merged = mergeSessionConversationPages([
      page(["9007199254740993124", "9007199254740993125"], {
        oldestCursor: "opaque:new-page-oldest",
        newestCursor: "opaque:newest",
      }),
      page(["9007199254740993122", "9007199254740993124"], {
        hasMore: true,
        oldestCursor: "opaque:oldest",
        newestCursor: "opaque:old-page-newest",
      }),
    ]);

    expect(merged?.activities.map((activity) => activity.id)).toEqual([
      "9007199254740993122",
      "9007199254740993124",
      "9007199254740993125",
    ]);
    expect(merged?.pagination.activities).toMatchObject({
      oldest_cursor: "opaque:oldest",
      newest_cursor: "opaque:newest",
      has_more_older: true,
    });
  });

  it("orders activities by occurred_at, source_order, then lossless id", () => {
    const value = page(["9007199254740993125", "9007199254740993124", "7"]);
    value.activities[0].occurred_at = "2026-08-09T00:00:01.000Z";
    value.activities[0].source_order = "1";
    value.activities[1].source_order = "2";
    value.activities[2].source_order = "1";

    expect(
      mergeSessionConversationPages([value])?.activities.map(
        (activity) => activity.id,
      ),
    ).toEqual(["7", "9007199254740993124", "9007199254740993125"]);
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
    expect(sessionConversationRecoveryInterval(1, "syncing")).toBe(3_000);
    expect(sessionConversationRecoveryInterval(20, "syncing")).toBe(false);
    expect(sessionConversationRecoveryInterval(1, "complete")).toBe(30_000);
  });
});

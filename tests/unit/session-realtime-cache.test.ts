import { describe, expect, it } from "vitest";

import {
  appendRealtimeSessionActivity,
  isHistoryImportActivity,
  patchRealtimeSessionConversation,
  patchRealtimeSessionList,
  sessionActivityFromRealtime,
  sessionUpdateFromRealtime,
} from "@/hooks/use-realtime";
import type {
  SessionActivityItem,
  SessionConversation,
  SessionListItem,
} from "@/lib/types/domain";

function activity(id: string): SessionActivityItem {
  return {
    id,
    workspace_id: "workspace-1",
    session_id: "session-1",
    task_id: null,
    task_message_id: null,
    kind: "status",
    actor_type: "ai",
    content: `activity-${id}`,
    data: {},
    external_ref: `external-${id}`,
    created_at: `2026-08-10T00:00:${id.padStart(2, "0")}.000Z`,
    occurred_at: `2026-08-10T00:00:${id.padStart(2, "0")}.000Z`,
    source_order: id,
    source: "live",
  };
}

function page(ids: string[]): SessionConversation {
  return {
    session: { id: "session-1" } as SessionConversation["session"],
    history_sync: null,
    tasks: [],
    messages: [],
    input_requests: [],
    events: [],
    activities: ids.map(activity),
    pagination: {
      activities: {
        limit: 100,
        oldest_cursor: "opaque:oldest",
        newest_cursor: "opaque:newest",
        has_more_older: false,
      },
      legacy: {
        limit: 5000,
        tasks_truncated: false,
        messages_truncated: false,
        events_truncated: false,
      },
    },
  };
}

describe("session activity Realtime cache", () => {
  it("normalizes bigint ids from a Realtime insert payload", () => {
    expect(
      sessionActivityFromRealtime({ new: { ...activity("3"), id: 3 } }),
    ).toMatchObject({ id: "3", session_id: "session-1" });
    expect(sessionActivityFromRealtime({ new: { id: 3 } })).toBeNull();
  });

  it("appends an out-of-order activity to the newest page without dropping history", () => {
    const current = {
      pages: [page(["2", "4"]), page(["1"])],
      pageParams: [null, "2"],
    };

    const updated = appendRealtimeSessionActivity(current, activity("3"));

    expect(updated?.pages[0].activities.map((item) => item.id)).toEqual([
      "2",
      "3",
      "4",
    ]);
    expect(updated?.pages[1].activities.map((item) => item.id)).toEqual(["1"]);
    expect(updated?.pages[0].pagination.activities).toMatchObject({
      oldest_cursor: "opaque:oldest",
      newest_cursor: "opaque:newest",
    });
  });

  it("identifies imported history by source with an external-ref fallback", () => {
    expect(
      isHistoryImportActivity({ ...activity("1"), source: "codex_history" }),
    ).toBe(true);
    expect(
      isHistoryImportActivity({
        ...activity("2"),
        external_ref: "codex-history:thread:turn:item",
      }),
    ).toBe(true);
    expect(isHistoryImportActivity(activity("3"))).toBe(false);
  });

  it("ignores a duplicate already present on an older page", () => {
    const current = {
      pages: [page(["3", "4"]), page(["1", "2"])],
      pageParams: [null, "3"],
    };

    expect(appendRealtimeSessionActivity(current, activity("2"))).toBe(current);
  });

  it("patches heartbeat state in place without dropping enriched session data", () => {
    const update = sessionUpdateFromRealtime({
      new: {
        id: "session-1",
        status: "busy",
        last_seen_at: "2026-08-10T00:01:00.000Z",
      },
    });
    expect(update).not.toBeNull();

    const enriched = {
      id: "session-1",
      status: "online",
      last_seen_at: "2026-08-10T00:00:00.000Z",
      connection: { id: "connection-1", name: "Device" },
      current_task: { id: "task-1", title: "Task" },
      queued_task_count: 2,
    } as SessionListItem;
    const patchedList = patchRealtimeSessionList([enriched], update!);
    expect(patchedList[0]).toMatchObject({
      status: "busy",
      last_seen_at: "2026-08-10T00:01:00.000Z",
      connection: enriched.connection,
      current_task: enriched.current_task,
      queued_task_count: 2,
    });

    const current = { pages: [page(["1"])], pageParams: [null] };
    current.pages[0].session = enriched;
    const patchedConversation = patchRealtimeSessionConversation(
      current,
      update!,
    );
    expect(patchedConversation.pages[0].session).toMatchObject({
      status: "busy",
      connection: enriched.connection,
      current_task: enriched.current_task,
    });
  });

  it("applies a Web display name and removes a deletion-requested Session", () => {
    const session = {
      id: "session-1",
      name: "Bridge source name",
      user_name: null,
      connection: { id: "connection-1" },
      current_task: null,
      queued_task_count: 0,
    } as SessionListItem;

    expect(
      patchRealtimeSessionList(
        [session],
        sessionUpdateFromRealtime({
          new: { id: "session-1", user_name: "Web name" },
        })!,
      )[0].name,
    ).toBe("Web name");
    expect(
      patchRealtimeSessionList(
        [session],
        sessionUpdateFromRealtime({
          new: {
            id: "session-1",
            deletion_requested_at: "2026-08-10T00:02:00.000Z",
          },
        })!,
      ),
    ).toEqual([]);
  });
});

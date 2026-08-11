import { describe, expect, it } from "vitest";

import { reduceAppServerActivityStream } from "@/components/session-activity-stream";
import type { Json } from "@/lib/types/database";
import type { SessionActivityItem } from "@/lib/types/domain";

type AppActivityOptions = {
  id: string;
  phase: "started" | "delta" | "completed";
  content: string | null;
  kind?: "assistant_message" | "reasoning";
  sessionId?: string;
  turnRef?: string;
  itemRef?: string;
  chunkIndex?: number;
  createdAt?: string;
};

function appActivity({
  id,
  phase,
  content,
  kind = "assistant_message",
  sessionId = "session-1",
  turnRef = "turn-1",
  itemRef = "item-1",
  chunkIndex,
  createdAt = "2026-08-10T10:00:00.000Z",
}: AppActivityOptions): SessionActivityItem {
  return {
    id,
    workspace_id: "workspace-1",
    session_id: sessionId,
    task_id: null,
    task_message_id: null,
    kind,
    actor_type: "ai",
    content,
    data: {
      protocol: "codex-app-server/v1",
      phase,
      turn_ref: turnRef,
      item_ref: itemRef,
      ...(chunkIndex === undefined ? {} : { chunk_index: chunkIndex }),
    },
    external_ref: `app-server:${id}`,
    created_at: createdAt,
    occurred_at: createdAt,
    source_order: id,
    source: "live",
  };
}

function legacyActivity(id: string, data: Json = {}): SessionActivityItem {
  return {
    id,
    workspace_id: "workspace-1",
    session_id: "session-1",
    task_id: null,
    task_message_id: null,
    kind: "status",
    actor_type: "ai",
    content: "legacy",
    data,
    external_ref: null,
    created_at: "2026-08-10T10:00:00.000Z",
    occurred_at: "2026-08-10T10:00:00.000Z",
    source_order: id,
    source: "live",
  };
}

function appKey(activity: SessionActivityItem): string {
  const data = activity.data as Record<string, Json | undefined>;
  return [activity.session_id, data.turn_ref, data.item_ref].join(":");
}

describe("reduceAppServerActivityStream", () => {
  it("orders out-of-order delta chunks before concatenating them", () => {
    const reduced = reduceAppServerActivityStream([
      appActivity({ id: "3", phase: "delta", chunkIndex: 2, content: "C" }),
      appActivity({ id: "1", phase: "delta", chunkIndex: 0, content: "A" }),
      appActivity({ id: "2", phase: "delta", chunkIndex: 1, content: "B" }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toMatchObject({ id: "1", content: "ABC" });
  });

  it("de-duplicates chunk indexes and keeps the latest duplicate", () => {
    const reduced = reduceAppServerActivityStream([
      appActivity({ id: "1", phase: "delta", chunkIndex: 0, content: "old" }),
      appActivity({ id: "2", phase: "delta", chunkIndex: 1, content: "!" }),
      appActivity({ id: "3", phase: "delta", chunkIndex: 0, content: "new" }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toMatchObject({ id: "3", content: "new!" });
  });

  it("uses completed as the authoritative item and hides earlier phases", () => {
    const completed = appActivity({
      id: "3",
      phase: "completed",
      content: "authoritative final content",
    });

    const reduced = reduceAppServerActivityStream([
      completed,
      appActivity({ id: "2", phase: "delta", chunkIndex: 0, content: "draft" }),
      appActivity({ id: "1", phase: "started", content: "starting" }),
    ]);

    expect(reduced).toEqual([completed]);
    expect(reduced[0]).toBe(completed);
  });

  it("recovers reasoning deltas hidden by a legacy empty completion", () => {
    const reduced = reduceAppServerActivityStream([
      appActivity({
        id: "3",
        kind: "reasoning",
        phase: "completed",
        content: "（无可展示的思考摘要）",
      }),
      appActivity({
        id: "1",
        kind: "reasoning",
        phase: "delta",
        chunkIndex: 0,
        content: "检查实现",
      }),
      appActivity({
        id: "2",
        kind: "reasoning",
        phase: "delta",
        chunkIndex: 1,
        content: "并定位问题",
      }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toMatchObject({
      id: "3",
      kind: "reasoning",
      content: "检查实现并定位问题",
      data: expect.objectContaining({ phase: "completed" }),
    });
  });

  it("drops completed reasoning groups with no exposed summary", () => {
    expect(
      reduceAppServerActivityStream([
        appActivity({
          id: "1",
          kind: "reasoning",
          phase: "completed",
          content: null,
        }),
      ]),
    ).toEqual([]);
  });

  it("isolates groups by session, turn, and item", () => {
    const reduced = reduceAppServerActivityStream([
      appActivity({ id: "2", phase: "delta", chunkIndex: 1, content: "2" }),
      appActivity({
        id: "3",
        phase: "delta",
        chunkIndex: 0,
        content: "B",
        itemRef: "item-2",
      }),
      appActivity({ id: "1", phase: "delta", chunkIndex: 0, content: "A" }),
      appActivity({
        id: "4",
        phase: "delta",
        chunkIndex: 0,
        content: "C",
        turnRef: "turn-2",
      }),
      appActivity({
        id: "5",
        phase: "delta",
        chunkIndex: 0,
        content: "D",
        sessionId: "session-2",
      }),
    ]);

    expect(Object.fromEntries(reduced.map((activity) => [appKey(activity), activity.content]))).toEqual({
      "session-1:turn-1:item-1": "A2",
      "session-1:turn-1:item-2": "B",
      "session-1:turn-2:item-1": "C",
      "session-2:turn-1:item-1": "D",
    });
  });

  it("passes legacy and malformed protocol activities through unchanged", () => {
    const legacy = legacyActivity("1", { source: "legacy-adapter" });
    const malformed = legacyActivity("2", {
      protocol: "codex-app-server/v1",
      phase: "delta",
      turn_ref: "turn-1",
      item_ref: "item-1",
    });

    const reduced = reduceAppServerActivityStream([legacy, malformed]);

    expect(reduced).toEqual([legacy, malformed]);
    expect(reduced[0]).toBe(legacy);
    expect(reduced[1]).toBe(malformed);
  });
});

import { describe, expect, it } from "vitest";

import { sessionStatusMeta } from "@/components/task-meta";
import type { SessionListItem } from "@/lib/types/domain";

const completedTask = {
  id: "task-completed",
  title: "修复派发链路",
  status: "completed" as const,
  progress_note: null,
  progress_percent_estimate: 100,
  updated_at: "2026-08-18T00:00:00Z",
  awaiting_user_input: false,
};

function session(
  overrides: Partial<
    Pick<
      SessionListItem,
      | "unviewed_completed_count"
      | "last_completed_task"
      | "current_task"
      | "status"
      | "archived_at"
      | "inventory_active"
      | "last_seen_at"
    >
  >,
): Pick<
  SessionListItem,
  | "unviewed_completed_count"
  | "last_completed_task"
  | "current_task"
  | "status"
  | "archived_at"
  | "inventory_active"
  | "last_seen_at"
> {
  return {
    unviewed_completed_count: 0,
    last_completed_task: null,
    current_task: null,
    status: "online",
    archived_at: null,
    inventory_active: true,
    last_seen_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("sessionStatusMeta", () => {
  it("优先展示完成未查看的待查看状态", () => {
    expect(
      sessionStatusMeta(
        session({
          unviewed_completed_count: 1,
          last_completed_task: completedTask,
        }),
      ),
    ).toEqual({
      label: "待查看",
      badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
    });
  });

  it("多个未查看完成时带上数量", () => {
    expect(
      sessionStatusMeta(
        session({
          unviewed_completed_count: 3,
          last_completed_task: completedTask,
        }),
      ).label,
    ).toBe("待查看 ×3");
  });

  it("已查看且空闲时展示已完成", () => {
    expect(
      sessionStatusMeta(
        session({
          unviewed_completed_count: 0,
          last_completed_task: completedTask,
        }),
      ),
    ).toEqual({
      label: "已完成",
      badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
    });
  });

  it("有进行中的任务时回落为会话忙碌状态", () => {
    expect(
      sessionStatusMeta(
        session({
          last_completed_task: completedTask,
          current_task: {
            ...completedTask,
            id: "task-running",
            status: "running",
          },
          status: "busy",
        }),
      ).label,
    ).toBe("忙碌");
  });

  it("没有完成记录时保持会话在线状态", () => {
    expect(sessionStatusMeta(session({})).label).toBe("在线");
  });
});

import { describe, expect, it } from "vitest";

import { findPendingQuestion } from "@/hooks/pending-question";
import type { TaskMessageRow } from "@/lib/types/database";

function message(overrides: Partial<TaskMessageRow>): TaskMessageRow {
  return {
    id: "msg-1",
    workspace_id: "ws-1",
    task_id: "task-1",
    sender_type: "ai",
    sender_id: null,
    content: "问题",
    reply_to_message_id: null,
    requires_response: true,
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("findPendingQuestion", () => {
  it("返回最新一条待回复的 AI 问题", () => {
    const older = message({
      id: "older",
      created_at: "2026-01-01T00:00:00Z",
    });
    const newer = message({
      id: "newer",
      task_id: "leaf-9",
      created_at: "2026-01-02T00:00:00Z",
    });

    expect(findPendingQuestion([older, newer])).toBe(newer);
  });

  it("忽略用户消息、系统消息与无需回复的 AI 消息", () => {
    const fromUser = message({ sender_type: "user" });
    const fromSystem = message({ sender_type: "system" });
    const noResponseNeeded = message({ requires_response: false });

    expect(
      findPendingQuestion([fromUser, fromSystem, noResponseNeeded]),
    ).toBeNull();
  });

  it("已读问题不再视为待答", () => {
    const answered = message({ read_at: "2026-01-02T00:00:00Z" });
    expect(findPendingQuestion([answered])).toBeNull();
  });

  it("保留消息实际的 task_id（后代叶子路由依据）", () => {
    const leafQuestion = message({ task_id: "leaf-42" });
    expect(findPendingQuestion([leafQuestion])?.task_id).toBe("leaf-42");
  });

  it("空消息列表返回 null", () => {
    expect(findPendingQuestion([])).toBeNull();
  });
});

describe("findPendingQuestion（任务状态断言）", () => {
  type Case = {
    name: string;
    /** taskId → 当前状态。 */
    statuses: Record<string, string>;
    messages: TaskMessageRow[];
    expectedId: string | null;
  };

  const cases: Case[] = [
    {
      name: "最新问题属于已取消任务时忽略，选中较旧的 waiting 问题",
      statuses: { "leaf-a": "cancelled", "leaf-b": "waiting_user" },
      messages: [
        message({
          id: "older-waiting",
          task_id: "leaf-b",
          created_at: "2026-01-01T00:00:00Z",
        }),
        message({
          id: "newer-cancelled",
          task_id: "leaf-a",
          created_at: "2026-01-03T00:00:00Z",
        }),
      ],
      expectedId: "older-waiting",
    },
    {
      name: "问题属于已恢复 ready 的任务时忽略",
      statuses: { "leaf-a": "ready" },
      messages: [message({ id: "stale", task_id: "leaf-a" })],
      expectedId: null,
    },
    {
      name: "所属任务未知时忽略（防御）",
      statuses: {},
      messages: [message({ id: "unknown", task_id: "ghost" })],
      expectedId: null,
    },
    {
      name: "所属任务仍为 waiting_user 的问题被选中（祖先路由不回归）",
      statuses: { root: "waiting_user", "leaf-9": "waiting_user" },
      messages: [
        message({
          id: "leaf-question",
          task_id: "leaf-9",
          created_at: "2026-01-02T00:00:00Z",
        }),
      ],
      expectedId: "leaf-question",
    },
    {
      name: "多个 waiting 分支取最新",
      statuses: { "leaf-a": "waiting_user", "leaf-b": "waiting_user" },
      messages: [
        message({
          id: "a",
          task_id: "leaf-a",
          created_at: "2026-01-01T00:00:00Z",
        }),
        message({
          id: "b",
          task_id: "leaf-b",
          created_at: "2026-01-02T00:00:00Z",
        }),
      ],
      expectedId: "b",
    },
  ];

  it.each(cases)("$name", (testCase) => {
    const result = findPendingQuestion(
      testCase.messages,
      (taskId) => testCase.statuses[taskId] === "waiting_user",
    );
    expect(result?.id ?? null).toBe(testCase.expectedId);
  });
});

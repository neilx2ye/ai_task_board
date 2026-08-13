import { describe, expect, it } from "vitest";

import { SAFE_TASK_REALTIME_COLUMNS } from "@/hooks/use-realtime";
import type { TaskDatabaseRow } from "@/lib/types/database";

/**
 * 类型完整的 TaskDatabaseRow 样例（含密钥字段）：数据库行增减字段时
 * 此处会编译失败，迫使同步更新安全列清单。
 */
const FULL_TASK_ROW: TaskDatabaseRow = {
  id: "task-1",
  workspace_id: "ws-1",
  parent_task_id: null,
  root_task_id: "task-1",
  title: "示例任务",
  description: null,
  acceptance_criteria: null,
  status: "ready",
  priority: 50,
  position: null,
  model: null,
  reasoning_effort: null,
  assigned_session_id: null,
  claimed_by_session_id: null,
  claim_token_hash: "secret-hash",
  claimed_at: null,
  lease_expires_at: null,
  awaiting_user_input: false,
  required_capabilities: [],
  external_source: null,
  external_task_ref: null,
  external_conversation_ref: null,
  progress_note: null,
  progress_percent_estimate: null,
  result_summary: null,
  result_json: null,
  created_by_type: "user",
  created_by_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  completed_at: null,
};

describe("SAFE_TASK_REALTIME_COLUMNS", () => {
  const safeColumns: readonly string[] = SAFE_TASK_REALTIME_COLUMNS;

  it("明确排除 claim_token_hash", () => {
    expect(safeColumns).not.toContain("claim_token_hash");
  });

  it("覆盖数据库行除 claim_token_hash 外的全部字段", () => {
    const expected = Object.keys(FULL_TASK_ROW)
      .filter((key) => key !== "claim_token_hash")
      .sort();
    expect([...safeColumns].sort()).toEqual(expected);
  });

  it("没有重复列", () => {
    expect(new Set(safeColumns).size).toBe(safeColumns.length);
  });
});

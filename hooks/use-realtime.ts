"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { catchUpEventCursor } from "@/hooks/realtime-catchup";
import { useSupabase } from "@/hooks/use-supabase";
import type { TaskRow } from "@/lib/types/database";

const REALTIME_TABLES = [
  "tasks",
  "task_messages",
  "task_events",
  "ai_sessions",
  "artifacts",
] as const;

/**
 * tasks 表的 Realtime 订阅必须显式限制安全列：
 * claim_token_hash 对 authenticated 角色没有 SELECT 权限，
 * 订阅整行会被 Realtime 拒绝。此处列出 TaskRow 全部公开字段，
 * 明确排除 claim_token_hash。
 */
export const SAFE_TASK_REALTIME_COLUMNS = [
  "id",
  "workspace_id",
  "parent_task_id",
  "root_task_id",
  "title",
  "description",
  "acceptance_criteria",
  "status",
  "priority",
  "position",
  "assigned_session_id",
  "claimed_by_session_id",
  "claimed_at",
  "lease_expires_at",
  "required_capabilities",
  "external_source",
  "external_task_ref",
  "external_conversation_ref",
  "progress_note",
  "progress_percent_estimate",
  "result_summary",
  "result_json",
  "created_by_type",
  "created_by_id",
  "created_at",
  "updated_at",
  "completed_at",
] as const satisfies ReadonlyArray<keyof TaskRow>;

/** 从 postgres_changes payload 中提取 task_events 行 id；无法识别时返回 null。 */
function extractEventId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const row = (payload as { new?: unknown }).new;
  if (!row || typeof row !== "object") return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === "number" ? id : null;
}

/**
 * 订阅当前 Workspace 的 Supabase Realtime 数据库变更。
 * - 任何变化都会失效本地查询缓存，由 TanStack Query 重新拉取权威数据。
 * - 维护内存中的最新 TaskEvent id 游标：实时 payload 单调推进；
 *   每次 SUBSCRIBED（含断线重连）按 id > cursor 分页补拉遗漏事件，
 *   发现遗漏即失效查询，全量重拉仍是权威状态恢复手段。
 * - 补拉失败不破坏订阅；30 秒轮询（QueryClient 默认配置）继续兜底。
 * - workspace 变化时游标随 effect 重建而重置；cleanup 后不再写旧订阅。
 */
export function useRealtimeWorkspace(workspaceId: string | undefined) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!supabase || !workspaceId) return;

    let cancelled = false;
    // null 表示基线尚未建立；仅在闭包内使用，workspace 切换即重置。
    let cursor: number | null = null;
    let catchUpInFlight = false;

    const invalidateAll = () => queryClient.invalidateQueries();

    const advanceCursor = (id: number) => {
      if (cursor === null || id > cursor) cursor = id;
    };

    const fetchMaxEventId = async (): Promise<number> => {
      const { data, error } = await supabase
        .from("task_events")
        .select("id")
        .eq("workspace_id", workspaceId)
        .order("id", { ascending: false })
        .limit(1);
      if (error) throw error;
      return data?.[0]?.id ?? 0;
    };

    const fetchEventIdsAfter = async (
      afterId: number,
      limit: number,
    ): Promise<readonly number[]> => {
      const { data, error } = await supabase
        .from("task_events")
        .select("id")
        .eq("workspace_id", workspaceId)
        .gt("id", afterId)
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map((row) => row.id);
    };

    /** 初次建立基线，重连时补拉遗漏；与实时回调竞态时用 max 单调合并。 */
    const syncEventCursor = async () => {
      if (catchUpInFlight) return;
      catchUpInFlight = true;
      try {
        if (cursor === null) {
          advanceCursor(await fetchMaxEventId());
          return;
        }
        const result = await catchUpEventCursor({
          cursor,
          fetchPage: fetchEventIdsAfter,
        });
        // 补拉期间实时回调可能已推进游标，只取更大值。
        advanceCursor(result.cursor);
        if (result.missed > 0 && !cancelled) await invalidateAll();
      } finally {
        catchUpInFlight = false;
      }
    };

    const channel = supabase.channel(`workspace:${workspaceId}`);

    for (const table of REALTIME_TABLES) {
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter: `workspace_id=eq.${workspaceId}`,
          // tasks 订阅限制安全列（claim_token_hash 无 SELECT 权限），其他表整行。
          ...(table === "tasks"
            ? { select: [...SAFE_TASK_REALTIME_COLUMNS] }
            : null),
        },
        (payload) => {
          if (table === "task_events") {
            const id = extractEventId(payload);
            if (id !== null) advanceCursor(id);
          }
          void invalidateAll();
        },
      );
    }

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      void (async () => {
        try {
          await syncEventCursor();
        } catch {
          // 补拉失败不破坏订阅；权威状态由全量失效与轮询兜底恢复。
        }
        if (!cancelled) void invalidateAll();
      })();
    });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [supabase, workspaceId, queryClient]);
}

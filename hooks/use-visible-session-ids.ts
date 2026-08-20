"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { apiFetch } from "@/hooks/api-client";
import { VISIBLE_THREADS_QUERY_KEY } from "@/hooks/query-keys";

const LEGACY_STORAGE_KEY = "ai-task-board:visible-session-ids";
const LEGACY_HIDDEN_STORAGE_KEY = "ai-task-board:hidden-session-ids";
const EMPTY_IDS: string[] = [];
const PERSIST_DELAY_MS = 500;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type VisibleThreadsResponse = {
  threads?: { visible_session_ids: string[] } | null;
};

function normalizeSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !SESSION_ID_PATTERN.test(item) ||
      seen.has(item)
    ) {
      continue;
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function readLegacyVisibleIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    // 旧版按「隐藏列表」存储，语义已反转，直接丢弃。
    window.localStorage.removeItem(LEGACY_HIDDEN_STORAGE_KEY);
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? normalizeSessionIds(JSON.parse(raw) as unknown) : [];
  } catch {
    return [];
  }
}

function writeLegacyVisibleIds(ids: readonly string[]) {
  try {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 本地兜底不可用时仅保留本次页面生命周期内的状态。
  }
}

function clearLegacyVisibleIds() {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 清理失败不影响数据库同步。
  }
}

/**
 * 用户在 Sessions 页勾选「显示在侧栏」的 Thread id 集合。
 * 状态以数据库为准（按用户 + Workspace 跨设备同步），默认全部收进弹框，
 * 只记录被显式勾选的 id；旧版 localStorage 数据会在首次远端读取成功后
 * 迁移入库，之后不再写回 localStorage。
 */
export function useVisibleSessionIds() {
  const queryClient = useQueryClient();
  const editedRef = useRef(false);
  const editedIdsRef = useRef<string[] | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIdsRef = useRef<string[] | null>(null);

  const query = useQuery({
    queryKey: VISIBLE_THREADS_QUERY_KEY,
    queryFn: async () => {
      const data = await apiFetch<VisibleThreadsResponse>(
        "/api/user/visible-threads",
      );
      return normalizeSessionIds(data.threads?.visible_session_ids);
    },
    // SSR 水合时远端数据尚未返回，先以空集合渲染避免水合不一致。
    // placeholderData 保持 pending 状态，直到真正的远端读取结束。
    placeholderData: EMPTY_IDS,
    refetchOnWindowFocus: true,
  });

  const persistNow = useCallback((ids: readonly string[]) => {
    if (typeof window === "undefined") return;
    void apiFetch("/api/user/visible-threads", {
      method: "PUT",
      json: { session_ids: ids },
    }).catch(() => {
      // 数据库暂不可用时写回本地，作为本次设备上的兜底。
      writeLegacyVisibleIds(ids);
    });
  }, []);

  const persistSoon = useCallback(
    (ids: readonly string[]) => {
      pendingIdsRef.current = [...ids];
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        const pending = pendingIdsRef.current;
        pendingIdsRef.current = null;
        if (pending) persistNow(pending);
      }, PERSIST_DELAY_MS);
    },
    [persistNow],
  );

  // 首次远端读取完成后：数据库有值则以它为准；数据库为空则把旧
  // localStorage 状态迁移入库。用户已经开始编辑时不再回灌远端数据。
  useEffect(() => {
    if (!query.isFetched) return;
    if (editedRef.current) {
      // 远端回读不覆盖用户已经做出的本地修改。
      const edited = editedIdsRef.current;
      if (edited && !sameIds(normalizeSessionIds(query.data), edited)) {
        queryClient.setQueryData(VISIBLE_THREADS_QUERY_KEY, edited);
      }
      return;
    }
    if (query.isSuccess) {
      const remote = normalizeSessionIds(query.data);
      const legacy = readLegacyVisibleIds();
      if (remote.length === 0 && legacy.length > 0) {
        queryClient.setQueryData(VISIBLE_THREADS_QUERY_KEY, legacy);
        persistSoon(legacy);
      }
      clearLegacyVisibleIds();
    } else if (query.isError) {
      const legacy = readLegacyVisibleIds();
      if (legacy.length > 0) {
        queryClient.setQueryData(VISIBLE_THREADS_QUERY_KEY, legacy);
      }
    }
  }, [
    persistSoon,
    query.data,
    query.isError,
    query.isFetched,
    query.isSuccess,
    queryClient,
  ]);

  // 页面卸载时把尚未防抖提交的最新值补写一次，避免快速切换丢失状态。
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        if (pendingIdsRef.current) persistNow(pendingIdsRef.current);
      }
    };
  }, [persistNow]);

  const setSessionVisible = useCallback(
    (sessionId: string, visible: boolean) => {
      if (!SESSION_ID_PATTERN.test(sessionId)) return;
      const previous =
        queryClient.getQueryData<string[]>(VISIBLE_THREADS_QUERY_KEY) ??
        EMPTY_IDS;
      const current = normalizeSessionIds(previous);
      const nextSet = new Set(current);
      if (visible) {
        nextSet.add(sessionId);
      } else {
        nextSet.delete(sessionId);
      }
      const next = [...nextSet];
      if (sameIds(current, next)) return;
      editedRef.current = true;
      editedIdsRef.current = next;
      queryClient.setQueryData(VISIBLE_THREADS_QUERY_KEY, next);
      persistSoon(next);
    },
    [persistSoon, queryClient],
  );

  const visibleIds = useMemo(
    () => new Set(query.data ?? EMPTY_IDS),
    [query.data],
  );

  return { visibleIds, setSessionVisible };
}

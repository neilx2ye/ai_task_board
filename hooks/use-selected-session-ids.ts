"use client";

import { useCallback, useState, type SetStateAction } from "react";

const STORAGE_KEY = "ai-task-board:selected-session-ids";

function normalizeSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function readSelectedSessionIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeSessionIds(JSON.parse(raw) as unknown) : [];
  } catch {
    return [];
  }
}

function writeSelectedSessionIds(ids: readonly string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 存储不可用时仅保留本次页面生命周期内的状态。
  }
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** 按打开顺序持久化会话页当前挂载的 Thread 窗口。 */
export function useSelectedSessionIds() {
  const [selectedSessionIds, setSelectedSessionIdsState] = useState<string[]>(
    readSelectedSessionIds,
  );

  const setSelectedSessionIds = useCallback(
    (action: SetStateAction<string[]>) => {
      setSelectedSessionIdsState((previous) => {
        const requested =
          typeof action === "function" ? action(previous) : action;
        const next = normalizeSessionIds(requested);
        if (sameIds(previous, next)) return previous;
        writeSelectedSessionIds(next);
        return next;
      });
    },
    [],
  );

  return { selectedSessionIds, setSelectedSessionIds };
}

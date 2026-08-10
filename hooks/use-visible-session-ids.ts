"use client";

import { useCallback, useState } from "react";

const STORAGE_KEY = "ai-task-board:visible-session-ids";
const LEGACY_STORAGE_KEY = "ai-task-board:hidden-session-ids";

function readVisibleIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    // 旧版按「隐藏列表」存储，语义已反转，直接丢弃。
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

/**
 * 用户在 Sessions 页选择「显示在侧栏」的 Thread id 集合，持久化在 localStorage。
 * 默认全部收进弹框，只记录被显式勾选的 id，因此新注册的 Thread 默认不进侧栏。
 */
export function useVisibleSessionIds() {
  // 惰性初始化在服务端返回空集合；水合时会话列表尚未加载（LoadingBlock），
  // 渲染结果与服务端一致，不会产生水合不一致。
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(
    () => new Set(readVisibleIds()),
  );

  const setSessionVisible = useCallback(
    (sessionId: string, visible: boolean) => {
      setVisibleIds((prev) => {
        const next = new Set(prev);
        if (visible) {
          next.add(sessionId);
        } else {
          next.delete(sessionId);
        }
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
        } catch {
          // 存储不可用时仅保留本次会话内的状态。
        }
        return next;
      });
    },
    [],
  );

  return { visibleIds, setSessionVisible };
}

"use client";

import { useCallback, useState } from "react";

const STORAGE_KEY = "ai-task-board:removed-project-ids";

function readRemovedIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
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
 * 用户在项目 Tab 链「管理项目」里删除的项目 id 集合，持久化在 localStorage。
 * 删除只移除管理弹窗与 Tab 链中的展示，不会改动 Bridge 上的真实项目；
 * 与隐藏项目一样仅在当前浏览器生效，且可以随时恢复。
 */
export function useRemovedProjects() {
  const [removedProjectIds, setRemovedProjectIds] = useState<
    ReadonlySet<string>
  >(() => new Set(readRemovedIds()));

  const setProjectRemoved = useCallback((projectId: string, removed: boolean) => {
    setRemovedProjectIds((prev) => {
      const next = new Set(prev);
      if (removed) {
        next.add(projectId);
      } else {
        next.delete(projectId);
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // 存储不可用时仅保留本次会话内的状态。
      }
      return next;
    });
  }, []);

  return { removedProjectIds, setProjectRemoved };
}

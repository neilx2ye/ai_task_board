"use client";

import { useCallback, useState } from "react";

const STORAGE_KEY = "ai-task-board:hidden-project-ids";

function readHiddenIds(): string[] {
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
 * 用户在项目 Tab 链「管理项目」里隐藏的项目 id 集合，持久化在 localStorage。
 * 与 Thread 收纳一致，仅在当前浏览器生效。
 */
export function useHiddenProjects() {
  const [hiddenProjectIds, setHiddenProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(readHiddenIds()),
  );

  const setProjectHidden = useCallback(
    (projectId: string, hidden: boolean) => {
      setHiddenProjectIds((prev) => {
        const next = new Set(prev);
        if (hidden) {
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
    },
    [],
  );

  return { hiddenProjectIds, setProjectHidden };
}

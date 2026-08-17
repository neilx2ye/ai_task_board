"use client";

import { useCallback, useState } from "react";

const STORAGE_KEY = "ai-task-board:selected-project";

/** null 表示「全部」；字符串为项目 id（`path:…` 或 `unassigned`）。 */
function normalizeProjectId(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readSelectedProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeProjectId(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeSelectedProjectId(projectId: string | null) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projectId));
  } catch {
    // 存储不可用时仅保留本次页面生命周期内的状态。
  }
}

/** 跨「会话与上下文」「任务规划」两页共享并持久化当前选中的项目 Tab。 */
export function useSelectedProject() {
  const [selectedProjectId, setSelectedProjectIdState] = useState<
    string | null
  >(readSelectedProjectId);

  const setSelectedProjectId = useCallback((projectId: string | null) => {
    setSelectedProjectIdState((previous) => {
      if (previous === projectId) return previous;
      writeSelectedProjectId(projectId);
      return projectId;
    });
  }, []);

  return { selectedProjectId, setSelectedProjectId };
}

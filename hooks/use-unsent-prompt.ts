"use client";

import {
  useCallback,
  useSyncExternalStore,
  type SetStateAction,
} from "react";

const STORAGE_PREFIX = "ai-task-board:unsent-prompt:";

export function unsentPromptStorageKey(
  sessionId: string | null,
): string | null {
  return sessionId ? `${STORAGE_PREFIX}${sessionId}` : null;
}

export function readUnsentPrompt(sessionId: string | null): string {
  if (typeof window === "undefined") return "";
  const key = unsentPromptStorageKey(sessionId);
  if (!key) return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeUnsentPrompt(
  sessionId: string | null,
  draft: string,
): void {
  const key = unsentPromptStorageKey(sessionId);
  if (!key) return;
  try {
    if (draft) {
      window.localStorage.setItem(key, draft);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // 存储不可用时仅保留本次页面生命周期内的草稿。
  }
}

const sessionListeners = new Map<string, Set<() => void>>();

function subscribeUnsentPrompt(
  sessionId: string | null,
  notify: () => void,
): () => void {
  if (!sessionId) return () => {};

  const listeners = sessionListeners.get(sessionId) ?? new Set<() => void>();
  listeners.add(notify);
  sessionListeners.set(sessionId, listeners);

  // 其他标签页修改同一 Thread 的草稿时也同步刷新当前页面。
  const onStorage = (event: StorageEvent) => {
    if (event.key === unsentPromptStorageKey(sessionId)) notify();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener("storage", onStorage);
    listeners.delete(notify);
    if (listeners.size === 0) sessionListeners.delete(sessionId);
  };
}

/**
 * 按 Thread 把尚未发送的 Prompt 草稿暂存到浏览器 localStorage，
 * 关闭或刷新页面后可以恢复，发送成功后清空。
 */
export function useUnsentPrompt(sessionId: string | null) {
  const draft = useSyncExternalStore(
    useCallback(
      (notify) => subscribeUnsentPrompt(sessionId, notify),
      [sessionId],
    ),
    useCallback(() => readUnsentPrompt(sessionId), [sessionId]),
    // 服务端快照始终为空，客户端水合后再取本地草稿，避免水合不一致。
    () => "",
  );

  const setDraft = useCallback(
    (action: SetStateAction<string>) => {
      if (!sessionId) return;
      const previous = readUnsentPrompt(sessionId);
      const next = typeof action === "function" ? action(previous) : action;
      writeUnsentPrompt(sessionId, next);
      sessionListeners.get(sessionId)?.forEach((listener) => listener());
    },
    [sessionId],
  );

  return { draft, setDraft };
}

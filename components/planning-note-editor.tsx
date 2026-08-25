"use client";

import { useEffect, useRef, useState } from "react";

import { LoadingBlock } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * 思考/规划笔记的通用编辑器：接收服务端内容与保存回调，本地持有草稿，
 * 1 秒防抖自动保存。项目版与 Thread 版共用同一编辑体验，但数据源、
 * 查询 key 和存储表各自独立，由调用方保证。
 */
export function PlanningNoteEditor({
  ariaLabel,
  sectionTitle,
  scopeHint,
  placeholder,
  loadingLabel,
  serverContent,
  isError,
  onRetry,
  save,
  isSavePending,
  isSaveError,
  savedAt,
}: {
  ariaLabel: string;
  sectionTitle: string;
  scopeHint: string;
  placeholder: string;
  loadingLabel: string;
  serverContent: string | null;
  isError: boolean;
  onRetry: () => void;
  save: (content: string) => void;
  isSavePending: boolean;
  isSaveError: boolean;
  savedAt: Date | null;
}) {
  // draft 为 null 表示与服务器内容一致；一旦用户输入就持有本地草稿。
  const [draft, setDraft] = useState<string | null>(null);
  const content = draft ?? serverContent ?? "";
  const dirty =
    draft !== null && serverContent !== null && draft !== serverContent;
  const saveRef = useRef(save);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (!dirty || draft === null) return;
    const snapshot = draft;
    const timer = window.setTimeout(() => {
      // onSuccess 会把保存结果写回查询缓存；若草稿未再变化，dirty 自动消除，
      // 若用户又输入了新内容，draft !== serverContent 仍会触发下一轮保存。
      saveRef.current(snapshot);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [dirty, draft]);

  const statusLabel = isSavePending
    ? "保存中…"
    : dirty
      ? "编辑中，稍后自动保存"
      : isSaveError
        ? "保存失败，继续编辑会自动重试"
        : savedAt
          ? `已保存 ${savedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
          : null;

  return (
    <section
      aria-label={ariaLabel}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{sectionTitle}</h3>
          <p className="truncate text-xs text-muted-foreground">{scopeHint}</p>
        </div>
        {statusLabel ? (
          <span
            role="status"
            className={
              isSaveError
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {statusLabel}
          </span>
        ) : null}
      </header>
      {isError ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>规划笔记加载失败。</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
          >
            重试
          </Button>
        </div>
      ) : serverContent === null ? (
        <LoadingBlock label={loadingLabel} />
      ) : (
        <Textarea
          aria-label={ariaLabel}
          value={content}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          className="min-h-56 resize-y text-sm leading-6"
        />
      )}
    </section>
  );
}

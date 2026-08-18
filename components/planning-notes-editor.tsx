"use client";

import { useEffect, useState } from "react";

import { LoadingBlock } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { usePlanningNote, useSavePlanningNote } from "@/hooks/use-planning";

/**
 * 项目级的思考/规划笔记：按项目路径跨 Bridge 共享，加载后本地编辑，
 * 1 秒防抖自动保存。父组件用 key={projectRef} 在切换项目时强制重挂载，
 * 因此这里不需要处理项目切换的状态重置。
 */
export function PlanningNotesEditor({
  projectRef,
  projectName,
  workingDirectory,
}: {
  projectRef: string;
  projectName: string;
  workingDirectory: string | null;
}) {
  const noteQuery = usePlanningNote(projectRef);
  const saveNote = useSavePlanningNote();
  const serverContent = noteQuery.isSuccess
    ? (noteQuery.data?.content ?? "")
    : null;
  // draft 为 null 表示与服务器内容一致；一旦用户输入就持有本地草稿。
  const [draft, setDraft] = useState<string | null>(null);
  const content = draft ?? serverContent ?? "";
  const dirty =
    draft !== null && serverContent !== null && draft !== serverContent;

  useEffect(() => {
    if (!dirty || draft === null) return;
    const snapshot = draft;
    const timer = window.setTimeout(() => {
      // onSuccess 会把保存结果写回查询缓存；若草稿未再变化，dirty 自动消除，
      // 若用户又输入了新内容，draft !== serverContent 仍会触发下一轮保存。
      saveNote.mutate({
        project_ref: projectRef,
        content: snapshot,
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [projectRef, dirty, draft, saveNote]);

  const savedAt = noteQuery.data?.updated_at
    ? new Date(noteQuery.data.updated_at)
    : null;
  const statusLabel = saveNote.isPending
    ? "保存中…"
    : dirty
      ? "编辑中，稍后自动保存"
      : saveNote.isError
        ? "保存失败，继续编辑会自动重试"
        : savedAt
          ? `已保存 ${savedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
          : null;

  return (
    <section
      aria-label={`项目「${projectName}」的规划笔记`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">思考与规划</h3>
          <p className="truncate text-xs text-muted-foreground">
            {workingDirectory ?? projectName} · 跨 Bridge 共享
          </p>
        </div>
        {statusLabel ? (
          <span
            role="status"
            className={
              saveNote.isError
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {statusLabel}
          </span>
        ) : null}
      </header>
      {noteQuery.isError ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>规划笔记加载失败。</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void noteQuery.refetch()}
          >
            重试
          </Button>
        </div>
      ) : serverContent === null ? (
        <LoadingBlock label="加载规划笔记…" />
      ) : (
        <Textarea
          aria-label="规划笔记内容"
          value={content}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            "把对新任务的思考、线索和 TODO 写在这里。\n\n例如：\n- 背景与目标\n- 拆成哪几个 Turn 交给 AI 执行\n- 每个 Turn 的验收标准"
          }
          className="min-h-56 resize-y text-sm leading-6"
        />
      )}
    </section>
  );
}

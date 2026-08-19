"use client";

import { PlanningNoteEditor } from "@/components/planning-note-editor";
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
  const savedAt = noteQuery.data?.updated_at
    ? new Date(noteQuery.data.updated_at)
    : null;

  return (
    <PlanningNoteEditor
      ariaLabel={`项目「${projectName}」的规划笔记`}
      sectionTitle="思考与规划"
      scopeHint={`${workingDirectory ?? projectName} · 跨 Bridge 共享`}
      placeholder={
        "把对新任务的思考、线索和 TODO 写在这里。\n\n例如：\n- 背景与目标\n- 拆成哪几个 Turn 交给 AI 执行\n- 每个 Turn 的验收标准"
      }
      loadingLabel="加载规划笔记…"
      serverContent={serverContent}
      isError={noteQuery.isError}
      onRetry={() => void noteQuery.refetch()}
      save={(content) =>
        saveNote.mutate({ project_ref: projectRef, content })
      }
      isSavePending={saveNote.isPending}
      isSaveError={saveNote.isError}
      savedAt={savedAt}
    />
  );
}

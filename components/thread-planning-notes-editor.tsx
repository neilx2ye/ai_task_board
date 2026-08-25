"use client";

import { PlanningNoteEditor } from "@/components/planning-note-editor";
import {
  useSaveThreadPlanningNote,
  useThreadPlanningNote,
} from "@/hooks/use-planning";

/**
 * Thread 级思考/规划笔记：仅绑定这一个 AI Session，不与项目级
 * planning_notes 共享或合并。父组件用 key={sessionId} 切换 Thread 时
 * 强制重挂载，因此这里不需要处理会话切换的草稿重置。
 */
export function ThreadPlanningNotesEditor({
  sessionId,
  sessionName,
}: {
  sessionId: string;
  sessionName: string;
}) {
  const noteQuery = useThreadPlanningNote(sessionId);
  const saveNote = useSaveThreadPlanningNote();
  const serverContent = noteQuery.isSuccess
    ? (noteQuery.data?.content ?? "")
    : null;
  const savedAt = noteQuery.data?.updated_at
    ? new Date(noteQuery.data.updated_at)
    : null;

  return (
    <PlanningNoteEditor
      ariaLabel={`Thread「${sessionName}」的规划笔记`}
      sectionTitle="Thread 思考与规划"
      scopeHint="仅属于这个 Thread · 不与项目规划共享"
      placeholder={
        "把对这个 Thread 的目标、背景和推进思路写在这里。\n\n项目级共享内容请写到左侧项目规划；这里只放这个 Thread 自己的计划。"
      }
      loadingLabel="加载 Thread 规划笔记…"
      serverContent={serverContent}
      isError={noteQuery.isError}
      onRetry={() => void noteQuery.refetch()}
      save={(content) =>
        saveNote.mutate({ session_id: sessionId, content })
      }
      isSavePending={saveNote.isPending}
      isSaveError={saveNote.isError}
      savedAt={savedAt}
    />
  );
}

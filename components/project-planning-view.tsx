"use client";

import { ChevronRightIcon, FolderIcon } from "lucide-react";

import { connectionColorMeta } from "@/components/connection-meta";
import { PlanningNotesEditor } from "@/components/planning-notes-editor";
import { SESSION_STATUS_META } from "@/components/task-meta";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/utils";
import { bridgeKindDisplayName } from "@/lib/agent-platforms";
import { effectiveSessionStatus } from "@/lib/domain/session-presence";
import type {
  SessionProjectBridge,
  SessionProjectGroup,
} from "@/lib/domain/session-directory-groups";

/**
 * 项目级规划视图（跨 Bridge）：一份按项目路径共享的思考笔记，
 * 加上该项目下所有 Bridge 的 Thread 入口清单。
 * 选中 Thread 后进入它独立的 Turn 规划链，与项目规划不再混在一起。
 */
export function ProjectPlanningView({
  project,
  bridges,
  onOpenThread,
}: {
  project: SessionProjectGroup;
  bridges: SessionProjectBridge[];
  onOpenThread: (sessionId: string) => void;
}) {
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 lg:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-base font-semibold">
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            {project.name}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {project.workingDirectory ?? "无工作目录信息"}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0">
          跨 {bridges.length} 个 Bridge 共享
        </Badge>
      </header>

      <PlanningNotesEditor
        key={project.id}
        projectRef={project.id}
        projectName={project.name}
        workingDirectory={project.workingDirectory}
      />

      <section
        aria-label={`项目「${project.name}」的 Threads`}
        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm"
      >
        <header>
          <h3 className="text-sm font-semibold">项目下的 Threads</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            按 Bridge 分组列出；打开某个 Thread 即可编辑它独立的规划笔记，
            并编排 Turn 规划链。
          </p>
        </header>
        {project.sessionCount === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            这个项目还没有 Thread，可在左侧 Bridge 的「+」新建一个。
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {bridges.map(({ groupId, platform, connection, directory }) => (
              <div key={groupId}>
                <div className="mb-1 flex items-center gap-2 px-1">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      connectionColorMeta(connection.id).dotClass,
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {connection.name}
                  </span>
                  {platform ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {bridgeKindDisplayName(platform)}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {directory.sessions.length} 个 Thread
                  </span>
                </div>
                {directory.sessions.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    该 Bridge 暂无可规划的 Thread
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {directory.sessions.map((session) => {
                      const statusMeta =
                        SESSION_STATUS_META[effectiveSessionStatus(session)];
                      return (
                        <li key={session.id}>
                          <button
                            type="button"
                            onClick={() => onOpenThread(session.id)}
                            aria-label={`打开 Thread「${session.name}」的规划与 Turn 链`}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left transition-colors",
                              "hover:bg-secondary/50 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                            )}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {session.name}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                {session.current_task
                                  ? `正在执行：${session.current_task.title}`
                                  : "当前空闲"}
                                {session.queued_task_count > 0
                                  ? ` · 已预留 ${session.queued_task_count} 项`
                                  : ""}
                              </span>
                            </span>
                            <Badge
                              variant="outline"
                              className={cn("shrink-0", statusMeta.badgeClass)}
                            >
                              {statusMeta.label}
                            </Badge>
                            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

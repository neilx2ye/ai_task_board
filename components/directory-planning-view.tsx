"use client";

import { ChevronRightIcon, FolderIcon } from "lucide-react";

import { PlanningNotesEditor } from "@/components/planning-notes-editor";
import { SESSION_STATUS_META } from "@/components/task-meta";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/utils";
import { effectiveSessionStatus } from "@/lib/domain/session-presence";
import type {
  SessionConnectionGroup,
  SessionDirectoryGroup,
} from "@/lib/domain/session-directory-groups";

/**
 * 项目目录级规划视图：目录下所有 Thread 共享的思考笔记，
 * 加上该项目 Thread 的入口清单。选中 Thread 后进入它的 Turn 规划链。
 */
export function DirectoryPlanningView({
  group,
  directory,
  onOpenThread,
}: {
  group: SessionConnectionGroup;
  directory: SessionDirectoryGroup;
  onOpenThread: (sessionId: string) => void;
}) {
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 lg:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-base font-semibold">
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            {directory.name}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {directory.workingDirectory ?? "无工作目录信息"}
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0">
          {group.connection.name}
        </Badge>
      </header>

      <PlanningNotesEditor
        key={`${group.connection.id}:${directory.id}`}
        connectionId={group.connection.id}
        directoryRef={directory.id}
        directoryName={directory.name}
        workingDirectory={directory.workingDirectory}
      />

      <section
        aria-label={`项目「${directory.name}」的 Threads`}
        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm"
      >
        <header>
          <h3 className="text-sm font-semibold">项目下的 Threads</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            打开某个 Thread 即可为它编排 Turn 规划链。
          </p>
        </header>
        {directory.sessions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            这个项目还没有 Thread，点左侧目录行的「+」新建一个。
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
                    aria-label={`打开 Thread「${session.name}」的 Turn 规划`}
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
      </section>
    </div>
  );
}

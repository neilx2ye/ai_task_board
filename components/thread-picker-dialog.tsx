"use client";

import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { DeleteUnselectedThreadsDialog } from "@/components/thread-management-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { sessionStatusMeta } from "@/components/task-meta";
import { cn } from "@/components/utils";
import type { SessionDirectoryGroup } from "@/lib/domain/session-directory-groups";
import { connectionPlatformLabel } from "@/lib/agent-platforms";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";

type ThreadPickerListProps = {
  sessions: SessionListItem[];
  visibleIds: ReadonlySet<string>;
  onToggle: (sessionId: string, visible: boolean) => void;
  onOpen: (sessionId: string) => void;
  canManage: boolean;
  canRename?: boolean;
  onRename: (session: SessionListItem) => void;
  onDelete: (session: SessionListItem) => void;
};

type BulkDeleteTarget = {
  projectName: string;
  sessions: SessionListItem[];
  skippedCount: number;
};

const DEFAULT_DIALOG_WIDTH = 672;
const MIN_DIALOG_WIDTH = 480;
const DIALOG_VIEWPORT_GUTTER = 32;

export function clampThreadPickerDialogWidth(
  width: number,
  viewportWidth: number,
): number {
  const maximum = Math.max(0, viewportWidth - DIALOG_VIEWPORT_GUTTER);
  const minimum = Math.min(MIN_DIALOG_WIDTH, maximum);
  return Math.min(maximum, Math.max(minimum, width));
}

export function canDeleteThread(session: SessionListItem): boolean {
  return (
    session.current_task === null &&
    session.queued_task_count === 0 &&
    session.inventory_active &&
    session.archived_at === null
  );
}

export function getUnselectedThreadDeletePlan(
  sessions: readonly SessionListItem[],
  visibleIds: ReadonlySet<string>,
): { sessions: SessionListItem[]; skippedCount: number } {
  const unselectedSessions = sessions.filter(
    (session) => !visibleIds.has(session.id),
  );
  const deletableSessions = unselectedSessions.filter(canDeleteThread);
  return {
    sessions: deletableSessions,
    skippedCount: unselectedSessions.length - deletableSessions.length,
  };
}

/** 只展示当前项目的 Thread；项目切换入口位于会话页左侧。 */
export function ThreadPickerList({
  sessions,
  visibleIds,
  onToggle,
  onOpen,
  canManage,
  canRename = canManage,
  onRename,
  onDelete,
}: ThreadPickerListProps) {
  return (
    <ul className="flex max-h-[min(60dvh,28rem)] flex-col divide-y divide-border/70 overflow-y-auto pr-1">
      {sessions.map((session) => {
        const visible = visibleIds.has(session.id);
        const deletable = canDeleteThread(session);
        const model = session.configured_model ?? session.model;
        const statusMeta = sessionStatusMeta(session);
        return (
          <li
            key={session.id}
            className="flex items-center gap-2 px-2 py-2.5 hover:bg-secondary/50"
          >
            <input
              type="checkbox"
              checked={visible}
              onChange={(event) =>
                onToggle(session.id, event.target.checked)
              }
              aria-label={`在侧栏显示 Thread「${session.name}」`}
              className="size-4 shrink-0 cursor-pointer accent-indigo-600"
            />
            <button
              type="button"
              onClick={() => onOpen(session.id)}
              title="在控制台打开"
              className="min-w-0 flex-1 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span
                className={cn(
                  "block text-sm leading-snug font-medium break-words",
                  !visible && "text-muted-foreground",
                )}
              >
                {session.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {session.working_directory ?? session.platform}
                {model ? ` · ${model}` : ""}
                {session.configured_reasoning_effort
                  ? ` / ${session.configured_reasoning_effort}`
                  : ""}
                {session.thread_settings_status === "queued" ||
                session.thread_settings_status === "running"
                  ? " · 设置待应用"
                  : ""}
              </span>
            </button>
            <Badge className={cn("shrink-0", statusMeta.badgeClass)}>
              {statusMeta.label}
            </Badge>
            {canManage ? (
              <div className="flex shrink-0 items-center gap-0.5">
                {canRename ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={
                      !session.inventory_active || session.archived_at !== null
                    }
                    onClick={() => onRename(session)}
                    aria-label={`重命名 Thread「${session.name}」`}
                    title={
                      !session.inventory_active || session.archived_at !== null
                        ? "Thread 已不在设备清单中"
                        : "重命名"
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  disabled={!deletable}
                  onClick={() => onDelete(session)}
                  aria-label={`删除 Thread「${session.name}」`}
                  title={
                    !session.inventory_active || session.archived_at !== null
                      ? "Thread 已不在设备清单中"
                      : session.current_task || session.queued_task_count > 0
                        ? "有进行中或已预留任务，暂时不能删除"
                        : "删除"
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 选择当前项目下要在侧栏显示的 Threads；未勾选的 Thread 只出现在这个弹框里。
 * 点击 Thread 名称可直接在右侧控制台打开（不改变其显示设置）。
 */
export function ThreadPickerDialog({
  connection,
  project,
  visibleIds,
  onToggle,
  onOpen,
  canManage,
  canRename,
  canCreate,
  onCreate,
  onRename,
  onDelete,
  onBulkDeleteSubmitted,
  open,
  onOpenChange,
}: {
  connection: SessionConnectionSummary | null;
  project: SessionDirectoryGroup | null;
  visibleIds: ReadonlySet<string>;
  onToggle: (sessionId: string, visible: boolean) => void;
  onOpen: (sessionId: string) => void;
  canManage: boolean;
  canRename: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onRename: (session: SessionListItem) => void;
  onDelete: (session: SessionListItem) => void;
  onBulkDeleteSubmitted: (result: {
    deletedCount: number;
    skippedCount: number;
  }) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sessions = project?.sessions ?? [];
  const agentName = connectionPlatformLabel(connection?.platform);
  const deletePlan = getUnselectedThreadDeletePlan(sessions, visibleIds);
  const [bulkDeleteTarget, setBulkDeleteTarget] =
    useState<BulkDeleteTarget | null>(null);
  const [dialogWidth, setDialogWidth] = useState(DEFAULT_DIALOG_WIDTH);
  const resizeState = useRef<{
    pointerId: number;
    lastX: number;
    width: number;
  } | null>(null);

  const onResizePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const width =
      event.currentTarget.parentElement?.getBoundingClientRect().width ??
      dialogWidth;
    resizeState.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      width,
    };
    setDialogWidth(width);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onResizePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = resizeState.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = event.clientX - current.lastX;
    current.lastX = event.clientX;
    current.width = clampThreadPickerDialogWidth(
      current.width + delta * 2,
      window.innerWidth,
    );
    setDialogWidth(current.width);
    event.preventDefault();
  };

  const finishResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    resizeState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onResizeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const width =
      event.currentTarget.parentElement?.getBoundingClientRect().width ??
      dialogWidth;
    setDialogWidth(
      clampThreadPickerDialogWidth(
        width + (event.key === "ArrowRight" ? 32 : -32),
        window.innerWidth,
      ),
    );
    event.preventDefault();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-none"
          style={{
            width: `${dialogWidth}px`,
            maxWidth: `calc(100vw - ${DIALOG_VIEWPORT_GUTTER}px)`,
          }}
        >
          <DialogHeader>
            <div className="flex items-center justify-between gap-3 pr-7">
              <DialogTitle>
                {project ? `管理 Threads · ${project.name}` : "管理 Threads"}
              </DialogTitle>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {canManage && project ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={deletePlan.sessions.length === 0}
                    title={
                      deletePlan.sessions.length > 0
                        ? deletePlan.skippedCount > 0
                          ? `另有 ${deletePlan.skippedCount} 个未勾选 Thread 当前不能删除`
                          : "删除当前项目中所有未勾选的 Threads"
                        : deletePlan.skippedCount > 0
                          ? "未勾选的 Threads 当前都不能删除"
                          : "没有未勾选的 Thread"
                    }
                    onClick={() => {
                      setBulkDeleteTarget({
                        projectName: project.name,
                        sessions: deletePlan.sessions,
                        skippedCount: deletePlan.skippedCount,
                      });
                      onOpenChange(false);
                    }}
                  >
                    <Trash2Icon />
                    删除未勾选（{deletePlan.sessions.length}）
                  </Button>
                ) : null}
                {canManage && canCreate && connection && project ? (
                  <Button type="button" size="sm" onClick={onCreate}>
                    <PlusIcon />
                    新建 Thread
                  </Button>
                ) : null}
              </div>
            </div>
            <DialogDescription>
              {connection && project
                ? canManage
                  ? `「${connection.name}」的项目「${project.name}」共 ${sessions.length} 个 Thread。勾选控制侧栏显示；未勾选项可批量删除，${
                      canRename ? "重命名和删除" : "删除"
                    }会同步到本机 ${agentName}。`
                  : `「${connection.name}」的项目「${project.name}」共 ${sessions.length} 个 Thread。勾选控制侧栏显示；重命名和删除仅对 Workspace 所有者开放，并需要 Bridge 0.5。`
                : "选择一个项目后管理其中的 Threads。"}
            </DialogDescription>
          </DialogHeader>

          {project ? (
            <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              项目目录：{project.workingDirectory ?? "无工作目录信息"}
            </div>
          ) : null}

          {project && sessions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              这个项目还没有 Thread。
            </div>
          ) : project ? (
            <ThreadPickerList
              sessions={sessions}
              visibleIds={visibleIds}
              onToggle={onToggle}
              onOpen={onOpen}
              canManage={canManage}
              canRename={canRename}
              onRename={onRename}
              onDelete={onDelete}
            />
          ) : null}

          <button
            type="button"
            aria-label="调整管理 Threads 弹窗宽度"
            title="拖拽或使用左右方向键调整弹窗宽度"
            className="group absolute top-1/2 right-0 z-20 hidden h-20 w-3 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center rounded-l-md outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring/50 sm:flex"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onLostPointerCapture={() => {
              resizeState.current = null;
            }}
            onKeyDown={onResizeKeyDown}
          >
            <span className="h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-muted-foreground/60 group-focus-visible:bg-muted-foreground/60" />
          </button>
        </DialogContent>
      </Dialog>

      {bulkDeleteTarget ? (
        <DeleteUnselectedThreadsDialog
          sessions={bulkDeleteTarget.sessions}
          projectName={bulkDeleteTarget.projectName}
          skippedCount={bulkDeleteTarget.skippedCount}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setBulkDeleteTarget(null);
          }}
          onSubmitted={(deletedCount) => {
            onBulkDeleteSubmitted({
              deletedCount,
              skippedCount: bulkDeleteTarget.skippedCount,
            });
            setBulkDeleteTarget(null);
          }}
        />
      ) : null}
    </>
  );
}

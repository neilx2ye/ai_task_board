"use client";

import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SESSION_STATUS_META } from "@/components/task-meta";
import { cn } from "@/components/utils";
import { effectiveSessionStatus } from "@/lib/domain/session-presence";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";

/**
 * 选择设备下要在侧栏显示的 Threads；未勾选的 Thread 只出现在这个弹框里。
 * 点击 Thread 名称可直接在右侧控制台打开（不改变其显示设置）。
 */
export function ThreadPickerDialog({
  connection,
  sessions,
  visibleIds,
  onToggle,
  onOpen,
  canManage,
  canCreate,
  onCreate,
  onRename,
  onDelete,
  open,
  onOpenChange,
}: {
  connection: SessionConnectionSummary | null;
  sessions: SessionListItem[];
  visibleIds: ReadonlySet<string>;
  onToggle: (sessionId: string, visible: boolean) => void;
  onOpen: (sessionId: string) => void;
  canManage: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onRename: (session: SessionListItem) => void;
  onDelete: (session: SessionListItem) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-7">
            <DialogTitle>管理 Threads</DialogTitle>
            {canManage && canCreate && connection ? (
              <Button type="button" size="sm" onClick={onCreate}>
                <PlusIcon />
                新建 Thread
              </Button>
            ) : null}
          </div>
          <DialogDescription>
            {connection
              ? canManage
                ? `「${connection.name}」共 ${sessions.length} 个 Thread。勾选控制侧栏显示；重命名和删除会同步到本机 Codex。${canCreate ? "" : " 请从左侧具体工作目录的新建按钮创建 Thread。"}`
                : `「${connection.name}」共 ${sessions.length} 个 Thread。管理操作仅对 Workspace 所有者开放，并需要 Bridge 0.5。`
              : "勾选的显示在侧栏，其余保留在这里。"}
          </DialogDescription>
        </DialogHeader>

        {sessions.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            这个设备还没有 Thread。
          </div>
        ) : (
          <ul className="flex max-h-[min(60dvh,26rem)] flex-col gap-1 overflow-y-auto pr-1">
            {sessions.map((session) => {
              const visible = visibleIds.has(session.id);
              const statusMeta =
                SESSION_STATUS_META[effectiveSessionStatus(session)];
              return (
                <li
                  key={session.id}
                  className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-secondary/50"
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
                      {session.model ? ` · ${session.model}` : ""}
                    </span>
                  </button>
                  <Badge className={cn("shrink-0", statusMeta.badgeClass)}>
                    {statusMeta.label}
                  </Badge>
                  {canManage ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        disabled={
                          !session.inventory_active ||
                          session.archived_at !== null
                        }
                        onClick={() => onRename(session)}
                        aria-label={`重命名 Thread「${session.name}」`}
                        title={
                          !session.inventory_active ||
                          session.archived_at !== null
                            ? "Thread 已不在设备清单中"
                            : "重命名"
                        }
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-destructive hover:text-destructive"
                        disabled={
                          session.current_task !== null ||
                          session.queued_task_count > 0 ||
                          !session.inventory_active ||
                          session.archived_at !== null
                        }
                        onClick={() => onDelete(session)}
                        aria-label={`删除 Thread「${session.name}」`}
                        title={
                          !session.inventory_active ||
                          session.archived_at !== null
                            ? "Thread 已不在设备清单中"
                            : session.current_task ||
                                session.queued_task_count > 0
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
        )}
      </DialogContent>
    </Dialog>
  );
}

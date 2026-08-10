"use client";

import { Badge } from "@/components/ui/badge";
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
  open,
  onOpenChange,
}: {
  connection: SessionConnectionSummary | null;
  sessions: SessionListItem[];
  visibleIds: ReadonlySet<string>;
  onToggle: (sessionId: string, visible: boolean) => void;
  onOpen: (sessionId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择要显示的 Threads</DialogTitle>
          <DialogDescription>
            {connection
              ? `「${connection.name}」共 ${sessions.length} 个 Thread，勾选的显示在侧栏，其余保留在这里。`
              : "勾选的显示在侧栏，其余保留在这里。"}
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-1">
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
                      "block truncate text-sm font-medium",
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
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ApiError } from "@/hooks/api-client";
import { SESSIONS_QUERY_KEY } from "@/hooks/query-keys";
import { usePauseTask } from "@/hooks/use-tasks";
import { isTaskRunningStatus } from "@/lib/domain/task-rules";
import type { SessionListItem } from "@/lib/types/domain";

/**
 * Thread 列表「停止」入口的确认与提交流程。停止复用暂停任务：
 * 服务端会尽力给设备 Bridge 下发中断指令，并把任务置为已暂停（可恢复）。
 */
export function StopRunningTaskDialog({
  session,
  open,
  onOpenChange,
  onStopped,
}: {
  session: SessionListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStopped: (notice: string) => void;
}) {
  const queryClient = useQueryClient();
  const task = session.current_task;
  const runningTask =
    task && isTaskRunningStatus(task.status) ? task : null;
  const pauseRunningTask = usePauseTask(runningTask?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (!runningTask) {
      onOpenChange(false);
      return;
    }
    setError(null);
    try {
      await pauseRunningTask.mutateAsync({});
      await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      onOpenChange(false);
      onStopped(
        `已停止 Thread「${session.name}」正在运行的任务「${runningTask.title}」，任务已置为已暂停；可在任务看板中恢复。`,
      );
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "INVALID_STATE_TRANSITION"
          ? "该任务包含子任务，无法在 Threads 页直接停止；请在任务看板中停止对应子任务。"
          : err instanceof Error
            ? err.message
            : "停止失败，请稍后重试",
      );
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="停止运行中的任务？"
      description={
        runningTask
          ? `将尽力中断设备上正在执行的 turn（最长约一个轮询周期），并把任务「${runningTask.title}」标记为已暂停；之后可在任务看板中恢复。`
          : undefined
      }
      confirmLabel="停止运行"
      pending={pauseRunningTask.isPending}
      onConfirm={() => void onConfirm()}
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

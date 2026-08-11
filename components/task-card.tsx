import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  priorityLevelOf,
  TASK_STATUS_META,
} from "@/components/task-meta";
import { cn, formatRelativeTime } from "@/components/utils";
import type {
  AISessionRow,
  TaskMessageRow,
  TaskRow,
} from "@/lib/types/database";

type Props = {
  task: TaskRow;
  /** 用于显示父任务 / 根任务标题。 */
  taskById: Map<string, TaskRow>;
  sessionById: Map<string, AISessionRow>;
  /** 递归叶子任务的完成数与总数（任意深度，不含已取消）。 */
  childStats?: { done: number; total: number };
  /** waiting_user 时最近一条 AI 问题（含后代冒泡上来的）。 */
  latestQuestion?: TaskMessageRow | null;
  /** 看板语义状态；用于把未绑定的历史 ready 叶子排除出“已预留”。 */
  displayStatus?: TaskRow["status"];
};

export function TaskCard({
  task,
  taskById,
  sessionById,
  childStats,
  latestQuestion,
  displayStatus,
}: Props) {
  const effectivelyWaiting = latestQuestion != null;
  const statusMeta = TASK_STATUS_META[
    effectivelyWaiting ? "waiting_user" : (displayStatus ?? task.status)
  ];
  const priority = priorityLevelOf(task.priority);
  const session =
    (task.claimed_by_session_id
      ? sessionById.get(task.claimed_by_session_id)
      : undefined) ??
    (task.assigned_session_id
      ? sessionById.get(task.assigned_session_id)
      : undefined);
  const parent = task.parent_task_id
    ? taskById.get(task.parent_task_id)
    : undefined;

  // waiting 聚合卡上的问题可能来自后代叶子：直接导航到问题所属任务，
  // 避免用户进入错误目标后再找子任务。
  const questionFromDescendant =
    effectivelyWaiting &&
    latestQuestion != null &&
    latestQuestion.task_id !== task.id;
  const href =
    questionFromDescendant && latestQuestion
      ? `/tasks/${latestQuestion.task_id}`
      : `/tasks/${task.id}`;
  const questionTask = questionFromDescendant
    ? taskById.get(latestQuestion.task_id)
    : undefined;

  return (
    <Link
      href={href}
      className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Card className="relative overflow-hidden transition-shadow hover:shadow-md">
        <span
          aria-hidden
          className={cn("absolute inset-y-0 left-0 w-1", statusMeta.barClass)}
        />
        <div className="flex flex-col gap-2 p-3 pl-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 flex-1 text-sm leading-snug font-medium break-words">
              {task.title}
            </h3>
            <Badge className={cn("shrink-0", statusMeta.badgeClass)}>
              {statusMeta.label}
            </Badge>
          </div>

          {parent ? (
            <p className="truncate text-xs text-muted-foreground">
              子任务 · {parent.title}
            </p>
          ) : null}

          {effectivelyWaiting && latestQuestion ? (
            <p className="line-clamp-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
              {questionFromDescendant ? (
                <span className="mr-1 font-medium">
                  来自子任务{questionTask ? `「${questionTask.title}」` : ""}：
                </span>
              ) : null}
              {latestQuestion.content}
            </p>
          ) : null}
          {task.status === "failed" && task.progress_note ? (
            <p className="line-clamp-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-800">
              {task.progress_note}
            </p>
          ) : null}
          {task.status === "running" && !effectivelyWaiting && task.progress_note ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {task.progress_note}
            </p>
          ) : null}

          {childStats && childStats.total > 0 ? (
            <div className="flex items-center gap-2">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={childStats.total}
                aria-valuenow={childStats.done}
                aria-label="叶子任务完成进度"
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-teal-500"
                  style={{
                    width: `${Math.round((childStats.done / childStats.total) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
                {childStats.done} / {childStats.total}
              </span>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <Badge className={cn("border", priority.badgeClass)}>
                {priority.label}
              </Badge>
              {session ? (
                <span className="truncate">
                  {session.platform} · {session.name}
                </span>
              ) : null}
            </span>
            <span
              className="shrink-0 tabular-nums"
              title={task.updated_at}
            >
              {formatRelativeTime(task.updated_at)}
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}

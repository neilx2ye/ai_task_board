"use client";

import { useMemo, useState } from "react";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { TaskCard } from "@/components/task-card";
import { TASK_STATUS_META } from "@/components/task-meta";
import { Badge } from "@/components/ui/badge";
import { useSessions } from "@/hooks/use-sessions";
import { useTasks } from "@/hooks/use-tasks";
import {
  calculateLeafProgress,
  taskBoardStatus,
} from "@/lib/domain/task-rules";
import { cn } from "@/components/utils";
import type {
  AISessionRow,
  TaskMessageRow,
  TaskRow,
  TaskStatus,
} from "@/lib/types/database";

type ColumnDef = {
  id: string;
  label: string;
  statuses: TaskStatus[];
  accentClass: string;
};

const COLUMNS: ColumnDef[] = [
  { id: "reserved", label: "已预留", statuses: ["ready"], accentClass: "bg-teal-500" },
  {
    id: "active",
    label: "AI 执行中",
    statuses: ["claimed", "running"],
    accentClass: "bg-indigo-500",
  },
  {
    id: "waiting",
    label: "等我回复",
    statuses: ["waiting_user"],
    accentClass: "bg-amber-500",
  },
  {
    id: "done",
    label: "已完成",
    statuses: ["completed"],
    accentClass: "bg-emerald-500",
  },
];

const FILTER_STATUSES: TaskStatus[] = ["inbox", "blocked", "failed", "cancelled"];

function sortTasks(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.created_at.localeCompare(b.created_at);
  });
}

/**
 * 复用领域规则计算递归叶子进度：统计任意深度下未取消的叶子任务完成数，
 * 与数据库结构化进度口径一致。只为有子任务的聚合任务生成条目。
 */
function buildLeafStats(
  tasks: TaskRow[],
): Map<string, { done: number; total: number }> {
  const hasChildren = new Set<string>();
  for (const task of tasks) {
    if (task.parent_task_id) hasChildren.add(task.parent_task_id);
  }
  const stats = new Map<string, { done: number; total: number }>();
  for (const task of tasks) {
    if (!hasChildren.has(task.id)) continue;
    const { completed_leaves, total_leaves } = calculateLeafProgress(
      tasks,
      task.id,
    );
    if (total_leaves > 0) {
      stats.set(task.id, { done: completed_leaves, total: total_leaves });
    }
  }
  return stats;
}

/**
 * 每个任务（含聚合父任务）的最新 AI 问题预览。
 * 消息按时间倒序处理后沿父子链向上传播：等待中的后代问题会冒泡到祖先，
 * 祖先优先展示其等待后代中最新的一条。
 */
function buildLatestQuestions(
  messages: TaskMessageRow[],
  taskById: Map<string, TaskRow>,
): Map<string, TaskMessageRow> {
  const map = new Map<string, TaskMessageRow>();
  const sorted = [...messages].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  for (const message of sorted) {
    // 防御过滤：只有未读的待回复 AI 消息才构成“等待用户”的预览，
    // 且消息所属任务当前必须仍为 waiting_user——已取消 / 已恢复分支的
    // 旧问题不能抢占仍等待分支的预览。
    if (
      message.sender_type !== "ai" ||
      !message.requires_response ||
      message.read_at !== null ||
      (taskById.get(message.task_id)?.status !== "waiting_user" &&
        taskById.get(message.task_id)?.awaiting_user_input !== true)
    ) {
      continue;
    }
    let currentId: string | null = message.task_id;
    let depth = 0;
    while (currentId && depth < 100) {
      if (!map.has(currentId)) map.set(currentId, message);
      currentId = taskById.get(currentId)?.parent_task_id ?? null;
      depth += 1;
    }
  }
  return map;
}

export default function BoardPage() {
  const tasksQuery = useTasks();
  const sessionsQuery = useSessions();
  const [visibleFilters, setVisibleFilters] = useState<Set<TaskStatus>>(
    () => new Set(),
  );

  const tasks = useMemo(
    () => tasksQuery.data?.tasks ?? [],
    [tasksQuery.data],
  );
  const sessions = useMemo(
    () => sessionsQuery.data ?? [],
    [sessionsQuery.data],
  );

  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const aggregateTaskIds = useMemo(
    () =>
      new Set(
        tasks
          .map((task) => task.parent_task_id)
          .filter((taskId): taskId is string => taskId !== null),
      ),
    [tasks],
  );
  const sessionById = useMemo(
    () => new Map(sessions.map((session: AISessionRow) => [session.id, session])),
    [sessions],
  );
  const childStats = useMemo(() => buildLeafStats(tasks), [tasks]);
  const latestQuestions = useMemo(
    () => buildLatestQuestions(tasksQuery.data?.latestAiMessages ?? [], taskById),
    [tasksQuery.data, taskById],
  );

  const toggleFilter = (status: TaskStatus) => {
    setVisibleFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const isLoading = tasksQuery.isLoading;
  const loadError = tasksQuery.error ?? sessionsQuery.error ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">会话任务流</h1>
        <p className="text-sm text-muted-foreground">
          任务跟随具体 AI 会话的上下文；Web Console 只做定向预留，不提供公共任务池。
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">全部任务 · {tasks.length}</p>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">显示其他状态：</span>
          {FILTER_STATUSES.map((status) => {
            const meta = TASK_STATUS_META[status];
            const active = visibleFilters.has(status);
            const count = tasks.filter(
              (task) =>
                taskBoardStatus(task, aggregateTaskIds.has(task.id)) === status,
            ).length;
            return (
              <button
                key={status}
                type="button"
                aria-pressed={active}
                onClick={() => toggleFilter(status)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  active
                    ? meta.badgeClass
                    : "border-border bg-card text-muted-foreground hover:bg-secondary",
                )}
              >
                {meta.label}（{count}）
              </button>
            );
          })}
        </div>
      </div>

      {loadError ? (
        <ErrorState
          message={loadError.message}
          onRetry={() => {
            void tasksQuery.refetch();
            void sessionsQuery.refetch();
          }}
        />
      ) : isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((column) => (
            <LoadingBlock key={column.id} label={`加载「${column.label}」…`} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {COLUMNS.map((column) => {
              const columnTasks = sortTasks(
                tasks.filter((task) =>
                  column.statuses.includes(
                    latestQuestions.has(task.id)
                      ? "waiting_user"
                      : taskBoardStatus(
                          task,
                          aggregateTaskIds.has(task.id),
                        ),
                  ),
                ),
              );
              return (
                <section
                  key={column.id}
                  aria-label={column.label}
                  className="flex min-w-0 flex-col gap-3 rounded-lg bg-muted/50 p-3"
                >
                  <header className="flex items-center gap-2 px-1">
                    <span
                      aria-hidden
                      className={cn("size-2 rounded-full", column.accentClass)}
                    />
                    <h2 className="text-sm font-semibold">{column.label}</h2>
                    <Badge variant="secondary" className="ml-auto tabular-nums">
                      {columnTasks.length}
                    </Badge>
                  </header>
                  <div className="flex flex-col gap-2.5">
                    {columnTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        taskById={taskById}
                        sessionById={sessionById}
                        childStats={childStats.get(task.id)}
                        latestQuestion={latestQuestions.get(task.id) ?? null}
                        displayStatus={taskBoardStatus(
                          task,
                          aggregateTaskIds.has(task.id),
                        )}
                      />
                    ))}
                    {columnTasks.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                        暂无任务
                      </p>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>

          {visibleFilters.size > 0 ? (
            <div className="grid items-start gap-4 sm:grid-cols-3">
              {FILTER_STATUSES.filter((status) => visibleFilters.has(status)).map(
                (status) => {
                  const meta = TASK_STATUS_META[status];
                  const filtered = sortTasks(
                    tasks.filter(
                      (task) =>
                        taskBoardStatus(
                          task,
                          aggregateTaskIds.has(task.id),
                        ) === status,
                    ),
                  );
                  return (
                    <section
                      key={status}
                      aria-label={meta.label}
                      className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3"
                    >
                      <header className="flex items-center gap-2 px-1">
                        <span
                          aria-hidden
                          className={cn("size-2 rounded-full", meta.barClass)}
                        />
                        <h2 className="text-sm font-semibold">{meta.label}</h2>
                        <Badge variant="secondary" className="ml-auto tabular-nums">
                          {filtered.length}
                        </Badge>
                      </header>
                      <div className="flex flex-col gap-2.5">
                        {filtered.map((task) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            taskById={taskById}
                            sessionById={sessionById}
                            childStats={childStats.get(task.id)}
                            displayStatus={status}
                          />
                        ))}
                        {filtered.length === 0 ? (
                          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                            暂无{meta.label}任务
                          </p>
                        ) : null}
                      </div>
                    </section>
                  );
                },
              )}
            </div>
          ) : null}

          {tasks.length === 0 ? (
            <EmptyState
              title="还没有会话任务"
              description="前往“AI 会话”选择已有上下文的会话并发送第一项任务。"
            />
          ) : null}
        </>
      )}
    </div>
  );
}

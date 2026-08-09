"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRightIcon, BotIcon, PlusIcon } from "lucide-react";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { TaskCard } from "@/components/task-card";
import { TaskFormDialog } from "@/components/task-form-dialog";
import { SESSION_STATUS_META, TASK_STATUS_META } from "@/components/task-meta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSessions } from "@/hooks/use-sessions";
import { useTasks } from "@/hooks/use-tasks";
import { calculateLeafProgress } from "@/lib/domain/task-rules";
import { isSessionAlive } from "@/lib/domain/session-presence";
import { cn, formatRelativeTime } from "@/components/utils";
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
      taskById.get(message.task_id)?.status !== "waiting_user"
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
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null);
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
  const liveSessions = useMemo(
    () => sessions.filter((session) => isSessionAlive(session)),
    [sessions],
  );

  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
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

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">存活会话</h2>
            <p className="text-xs text-muted-foreground">
              选择已经在 CLI 或 APP 中建立好上下文的会话，再预留任务。
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/sessions">
              管理会话
              <ArrowRightIcon />
            </Link>
          </Button>
        </div>

        {sessionsQuery.isLoading ? (
          <LoadingBlock label="确认会话心跳…" />
        ) : liveSessions.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {liveSessions.map((session) => {
              const queuedCount = tasks.filter(
                (task) =>
                  task.assigned_session_id === session.id &&
                  task.status === "ready",
              ).length;
              const statusMeta = SESSION_STATUS_META[session.status];
              return (
                <article
                  key={session.id}
                  className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-background p-3"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 rounded-md bg-indigo-50 p-1.5 text-indigo-700">
                      <BotIcon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-medium">{session.name}</h3>
                        <Badge className={cn("shrink-0", statusMeta.badgeClass)}>
                          {statusMeta.label}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {session.platform}
                        {session.model ? ` · ${session.model}` : ""}
                        {` · ${formatRelativeTime(session.last_seen_at)}`}
                      </p>
                      {session.external_conversation_ref ? (
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          上下文：{session.external_conversation_ref}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      已预留 {queuedCount} 项
                    </span>
                    <Button
                      size="sm"
                      onClick={() => setTargetSessionId(session.id)}
                      aria-label={`给 ${session.name} 预留任务`}
                    >
                      <PlusIcon />
                      预留任务
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-4">
            <div>
              <p className="text-sm font-medium">当前没有存活的 AI 会话</p>
              <p className="text-xs text-muted-foreground">
                先从 CLI 或 APP 注册会话并发送心跳，才能从 Web Console 定向派发。
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href="/connections">配置 AI 连接</Link>
            </Button>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">全部任务 · {tasks.length}</p>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">显示其他状态：</span>
          {FILTER_STATUSES.map((status) => {
            const meta = TASK_STATUS_META[status];
            const active = visibleFilters.has(status);
            const count = tasks.filter((task) => task.status === status).length;
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
                tasks.filter((task) => column.statuses.includes(task.status)),
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
                    tasks.filter((task) => task.status === status),
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
              description="在上方选择一个存活会话，为它预留第一项任务。"
            />
          ) : null}
        </>
      )}

      <TaskFormDialog
        open={targetSessionId !== null}
        onOpenChange={(open) => {
          if (!open) setTargetSessionId(null);
        }}
        initialSessionId={targetSessionId}
        lockInitialSession
      />
    </div>
  );
}

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BotIcon, PlusIcon } from "lucide-react";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { TaskFormDialog } from "@/components/task-form-dialog";
import { SESSION_STATUS_META } from "@/components/task-meta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useSessions } from "@/hooks/use-sessions";
import { useTasks } from "@/hooks/use-tasks";
import { cn, formatDateTime, formatRelativeTime } from "@/components/utils";
import {
  effectiveSessionStatus,
  isSessionAlive,
} from "@/lib/domain/session-presence";

export default function SessionsPage() {
  const sessionsQuery = useSessions();
  const tasksQuery = useTasks();
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null);

  const taskById = useMemo(
    () =>
      new Map((tasksQuery.data?.tasks ?? []).map((task) => [task.id, task])),
    [tasksQuery.data],
  );

  const error = sessionsQuery.error ?? null;
  const sessions = sessionsQuery.data ?? [];
  const liveSessions = sessions.filter((session) => isSessionAlive(session));
  const inactiveSessions = sessions.filter((session) => !isSessionAlive(session));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">AI 会话</h1>
        <p className="text-sm text-muted-foreground">
          会话是任务的上下文边界。先在 CLI 或 APP 中建立对话，再从这里向该会话预留任务。
        </p>
      </div>

      <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-sm text-indigo-950">
        Web Console 不创建等待 AI 自行挑选的公共任务。只有两分钟内持续心跳的会话可接收新任务；
        CLI 或 APP 已开始执行的任务则由会话直接同步到这里。
      </div>

      {error ? (
        <ErrorState
          message={error.message}
          onRetry={() => void sessionsQuery.refetch()}
        />
      ) : sessionsQuery.isLoading ? (
        <LoadingBlock label="加载 AI 会话…" />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<BotIcon className="size-6" />}
          title="还没有 AI 会话"
          description="在“AI 连接”页创建连接并配置到 AI 客户端后，客户端调用注册接口即可出现在这里。"
        />
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">存活会话</h2>
              <Badge variant="secondary">{liveSessions.length}</Badge>
            </div>
            {liveSessions.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                暂无近期心跳。请保持 CLI 或 APP 会话在线。
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {liveSessions.map((session) => {
                  const statusMeta = SESSION_STATUS_META[session.status];
                  const currentTask = session.current_task_id
                    ? taskById.get(session.current_task_id)
                    : undefined;
                  const reservedCount = (tasksQuery.data?.tasks ?? []).filter(
                    (task) =>
                      task.assigned_session_id === session.id &&
                      task.status === "ready",
                  ).length;
                  return (
                    <Card key={session.id}>
                      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="truncate text-sm font-semibold">
                            {session.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {session.platform}
                            {session.model ? ` · ${session.model}` : ""}
                          </span>
                        </div>
                        <Badge className={cn("shrink-0", statusMeta.badgeClass)}>
                          {statusMeta.label}
                        </Badge>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3">
                        {session.external_conversation_ref ? (
                          <div className="flex flex-col gap-1 text-sm">
                            <span className="text-xs text-muted-foreground">会话上下文</span>
                            <span className="truncate" title={session.external_conversation_ref}>
                              {session.external_conversation_ref}
                            </span>
                          </div>
                        ) : null}
                        <div className="flex flex-col gap-1 text-sm">
                          <span className="text-xs text-muted-foreground">当前任务</span>
                          {currentTask ? (
                            <Link
                              href={`/tasks/${currentTask.id}`}
                              className="truncate text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                              {currentTask.title}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">空闲</span>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                          <span className="text-xs text-muted-foreground">
                            已预留 {reservedCount} 项
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
                        <p className="text-xs text-muted-foreground">
                          最后心跳：
                          <time
                            dateTime={session.last_seen_at}
                            title={formatDateTime(session.last_seen_at)}
                          >
                            {formatRelativeTime(session.last_seen_at)}
                          </time>
                        </p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {inactiveSessions.length > 0 ? (
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">离线会话</h2>
                <Badge variant="secondary">{inactiveSessions.length}</Badge>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {inactiveSessions.map((session) => {
                  const statusMeta = SESSION_STATUS_META[effectiveSessionStatus(session)];
            const currentTask = session.current_task_id
              ? taskById.get(session.current_task_id)
              : undefined;
            return (
              <Card key={session.id}>
                <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-sm font-semibold">
                      {session.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {session.platform}
                      {session.model ? ` · ${session.model}` : ""}
                    </span>
                  </div>
                  <Badge className={cn("shrink-0", statusMeta.badgeClass)}>
                    {statusMeta.label}
                  </Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">
                      当前任务
                    </span>
                    {currentTask ? (
                      <Link
                        href={`/tasks/${currentTask.id}`}
                        className="truncate text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        {currentTask.title}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">空闲</span>
                    )}
                  </div>

                  {session.capabilities.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {session.capabilities.map((capability) => (
                        <Badge key={capability} variant="secondary">
                          {capability}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  <p className="text-xs text-muted-foreground">
                    最后心跳：
                    <time
                      dateTime={session.last_seen_at}
                      title={formatDateTime(session.last_seen_at)}
                    >
                      {formatRelativeTime(session.last_seen_at)}
                    </time>
                  </p>
                </CardContent>
              </Card>
            );
                })}
              </div>
            </section>
          ) : null}
        </div>
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

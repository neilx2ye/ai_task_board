"use client";

import { useMemo, useState } from "react";
import { BotIcon, ListFilterIcon, PlusIcon } from "lucide-react";

import { SessionConversationPanel } from "@/components/session-conversation-dialog";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { TaskFormDialog } from "@/components/task-form-dialog";
import { SESSION_STATUS_META, TASK_STATUS_META } from "@/components/task-meta";
import { ThreadPickerDialog } from "@/components/thread-picker-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/utils";
import { useVisibleSessionIds } from "@/hooks/use-visible-session-ids";
import { useSessions } from "@/hooks/use-sessions";
import {
  effectiveSessionStatus,
  isConnectionAlive,
  isSessionAlive,
} from "@/lib/domain/session-presence";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";

type ConnectionGroup = {
  connection: SessionConnectionSummary;
  sessions: SessionListItem[];
};

function groupSessionsByConnection(
  sessions: SessionListItem[],
): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();

  for (const session of sessions) {
    const existing = groups.get(session.connection.id);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(session.connection.id, {
        connection: session.connection,
        sessions: [session],
      });
    }
  }

  return [...groups.values()];
}

function SessionListRow({
  session,
  selected,
  onSelect,
  onReserve,
}: {
  session: SessionListItem;
  selected: boolean;
  onSelect: () => void;
  onReserve: () => void;
}) {
  const alive = isSessionAlive(session);
  const statusMeta = SESSION_STATUS_META[effectiveSessionStatus(session)];
  const task = session.current_task;
  const taskStatusMeta = task ? TASK_STATUS_META[task.status] : null;

  return (
    <div
      className={cn(
        "flex items-stretch border-b border-border transition-colors last:border-b-0",
        selected ? "bg-indigo-50/80" : "hover:bg-secondary/50",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        aria-label={`打开 Thread「${session.name}」`}
        onClick={onSelect}
        className="min-w-0 flex-1 cursor-pointer px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {session.name}
          </span>
          <Badge className={cn("shrink-0", statusMeta.badgeClass)}>
            {statusMeta.label}
          </Badge>
        </div>

        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {session.working_directory ?? session.platform}
          {session.model ? ` · ${session.model}` : ""}
        </p>

        <div className="mt-2 flex flex-col gap-1">
          {task ? (
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {task.title}
              </span>
              {taskStatusMeta ? (
                <Badge className={cn("shrink-0", taskStatusMeta.badgeClass)}>
                  {taskStatusMeta.label}
                </Badge>
              ) : null}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">当前空闲</span>
          )}
        </div>

        <p className="mt-2 text-xs text-muted-foreground tabular-nums">
          已预留 {session.queued_task_count} 项
        </p>
      </button>

      {alive ? (
        <div className="flex shrink-0 items-start px-2 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onReserve}
            aria-label={`给 ${session.name} 预留任务`}
            title="预留任务"
          >
            <PlusIcon />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function SessionsPage() {
  const sessionsQuery = useSessions();
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const { visibleIds, setSessionVisible } = useVisibleSessionIds();
  const [pickerConnectionId, setPickerConnectionId] = useState<string | null>(
    null,
  );

  const sessions = useMemo(
    () =>
      (sessionsQuery.data ?? []).filter(
        // 已撤销的连接及其 Thread 不在 AI 会话页展示。
        (session) => !session.connection.revoked_at,
      ),
    [sessionsQuery.data],
  );
  const connectionGroups = useMemo(
    () => groupSessionsByConnection(sessions),
    [sessions],
  );
  const pickerGroup = useMemo(
    () =>
      pickerConnectionId
        ? (connectionGroups.find(
            (group) => group.connection.id === pickerConnectionId,
          ) ?? null)
        : null,
    [pickerConnectionId, connectionGroups],
  );
  const selectedSession = useMemo(
    () =>
      selectedSessionId
        ? (sessions.find((session) => session.id === selectedSessionId) ?? null)
        : (sessions[0] ?? null),
    [selectedSessionId, sessions],
  );

  return (
    <div className="flex flex-col gap-5 lg:h-[calc(100dvh-3rem)]">
      <div className="shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">AI 会话</h1>
        <p className="text-sm text-muted-foreground">
          按设备切换 Thread，在同一控制台查看上下文、执行过程并继续发送任务。
        </p>
      </div>

      {sessionsQuery.error ? (
        <ErrorState
          message={sessionsQuery.error.message}
          onRetry={() => void sessionsQuery.refetch()}
        />
      ) : sessionsQuery.isLoading ? (
        <LoadingBlock label="加载 AI 会话…" />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<BotIcon className="size-6" />}
          title="还没有 AI 会话"
          description="在“AI 连接”页创建连接并配置到 AI 客户端后，客户端注册的会话会显示在这里。"
        />
      ) : (
        <div className="grid min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:grid-cols-[20rem_minmax(0,1fr)]">
          <aside className="border-b border-border lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0">
            <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
              <div>
                <h2 className="text-sm font-semibold">设备与 Threads</h2>
                <p className="text-xs text-muted-foreground">
                  选择一个上下文继续工作
                </p>
              </div>
              <Badge variant="secondary" className="tabular-nums">
                {sessions.length}
              </Badge>
            </header>

            <nav aria-label="设备与 Thread 列表">
              {connectionGroups.map(
                ({ connection, sessions: groupSessions }) => {
                  const deviceOnline = isConnectionAlive(connection);
                  const visibleSessions = groupSessions.filter((session) =>
                    visibleIds.has(session.id),
                  );
                  const hiddenCount =
                    groupSessions.length - visibleSessions.length;
                  return (
                    <section
                      key={connection.id}
                      aria-labelledby={`connection-${connection.id}`}
                      className="border-b border-border last:border-b-0"
                    >
                      <header className="bg-muted/40 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <h3
                            id={`connection-${connection.id}`}
                            className="min-w-0 flex-1 truncate text-xs font-semibold"
                          >
                            {connection.name}
                          </h3>
                          <Badge
                            variant="outline"
                            className={cn(
                              "shrink-0",
                              deviceOnline
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "text-muted-foreground",
                            )}
                          >
                            {deviceOnline ? "设备在线" : "设备离线"}
                          </Badge>
                          <Badge variant="outline" className="tabular-nums">
                            {groupSessions.length}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 shrink-0"
                            onClick={() => setPickerConnectionId(connection.id)}
                            aria-label={`选择「${connection.name}」要显示的 Threads`}
                            title="选择要显示的 Threads"
                          >
                            <ListFilterIcon className="size-3.5" />
                          </Button>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {connection.platform}
                          {connection.bridge_version
                            ? ` · Bridge ${connection.bridge_version}`
                            : ""}
                        </p>
                      </header>

                      <div>
                        {visibleSessions.map((session) => (
                          <SessionListRow
                            key={session.id}
                            session={session}
                            selected={session.id === selectedSession?.id}
                            onSelect={() => setSelectedSessionId(session.id)}
                            onReserve={() => setTargetSessionId(session.id)}
                          />
                        ))}
                        {hiddenCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => setPickerConnectionId(connection.id)}
                            className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-secondary/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                          >
                            <ListFilterIcon className="size-3.5 shrink-0" />
                            已收纳 {hiddenCount} 个 Thread · 点击管理
                          </button>
                        ) : null}
                      </div>
                    </section>
                  );
                },
              )}
            </nav>
          </aside>

          <div id="session-console" className="min-h-0">
            <SessionConversationPanel
              key={selectedSession?.id ?? "no-session"}
              session={selectedSession}
            />
          </div>
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

      <ThreadPickerDialog
        open={pickerGroup !== null}
        onOpenChange={(open) => {
          if (!open) setPickerConnectionId(null);
        }}
        connection={pickerGroup?.connection ?? null}
        sessions={pickerGroup?.sessions ?? []}
        visibleIds={visibleIds}
        onToggle={setSessionVisible}
        onOpen={(sessionId) => {
          setSelectedSessionId(sessionId);
          setPickerConnectionId(null);
        }}
      />
    </div>
  );
}

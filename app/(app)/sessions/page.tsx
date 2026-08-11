"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BotIcon, ListFilterIcon, PlusIcon } from "lucide-react";

import { SessionConversationPanel } from "@/components/session-conversation-dialog";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { TaskFormDialog } from "@/components/task-form-dialog";
import { SESSION_STATUS_META, TASK_STATUS_META } from "@/components/task-meta";
import { ThreadPickerDialog } from "@/components/thread-picker-dialog";
import {
  CreateThreadDialog,
  DeleteThreadDialog,
  RenameThreadDialog,
} from "@/components/thread-management-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/utils";
import { useVisibleSessionIds } from "@/hooks/use-visible-session-ids";
import { useSessions } from "@/hooks/use-sessions";
import {
  supportsWebThreadManagement,
  useConnections,
} from "@/hooks/use-connections";
import { useWorkspace } from "@/hooks/use-workspace";
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
  connections: SessionConnectionSummary[] = [],
): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();

  for (const connection of connections) {
    groups.set(connection.id, { connection, sessions: [] });
  }

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
  const taskStatusMeta = task
    ? TASK_STATUS_META[
        task.awaiting_user_input ? "waiting_user" : task.status
      ]
    : null;

  return (
    <div
      className={cn(
        "flex items-stretch border-b border-border transition-colors last:border-b-0",
        selected ? "bg-indigo-50/80" : "hover:bg-secondary/50",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selected ? "取消选中" : "选中"} Thread「${session.name}」`}
        title={selected ? "取消选中并清除已同步历史" : "在控制台打开"}
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
  const workspaceQuery = useWorkspace();
  const isOwner = workspaceQuery.data?.role === "owner";
  const connectionsQuery = useConnections(isOwner);
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null);
  // 按点选顺序保存选中的 Thread；只有选中的才会挂载面板并同步历史。
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const { visibleIds, setSessionVisible } = useVisibleSessionIds();
  const [pickerConnectionId, setPickerConnectionId] = useState<string | null>(
    null,
  );
  const [createConnectionId, setCreateConnectionId] = useState<string | null>(
    null,
  );
  const [renameSession, setRenameSession] = useState<SessionListItem | null>(
    null,
  );
  const [deleteSession, setDeleteSession] = useState<SessionListItem | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const sessions = useMemo(
    () =>
      (sessionsQuery.data ?? []).filter(
        // 已撤销的连接及其 Thread 不在 AI 会话页展示。
        (session) => !session.connection.revoked_at,
      ),
    [sessionsQuery.data],
  );
  const connectionGroups = useMemo(
    () =>
      groupSessionsByConnection(
        sessions,
        (connectionsQuery.data ?? [])
          .filter((connection) => connection.bridge_version !== null)
          .map((connection) => ({
            id: connection.id,
            name: connection.name,
            platform: connection.platform,
            last_seen_at: connection.last_seen_at,
            bridge_version: connection.bridge_version,
            revoked_at: connection.revoked_at,
          })),
      ),
    [connectionsQuery.data, sessions],
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
  const selectedSessions = useMemo(
    () =>
      selectedSessionIds
        .map((id) => sessions.find((session) => session.id === id))
        .filter(
          (session): session is SessionListItem => session !== undefined,
        ),
    [selectedSessionIds, sessions],
  );
  const queryClient = useQueryClient();
  /** 取消选中：面板随之卸载，同时清掉该 Thread 已同步的历史缓存。 */
  const deselectSession = (sessionId: string) => {
    setSelectedSessionIds((prev) => prev.filter((id) => id !== sessionId));
    queryClient.removeQueries({
      queryKey: ["sessions", sessionId],
      exact: true,
    });
  };
  const toggleSessionSelected = (sessionId: string) => {
    if (selectedSessionIds.includes(sessionId)) {
      deselectSession(sessionId);
    } else {
      setSelectedSessionIds((prev) => [...prev, sessionId]);
    }
  };
  const createGroup = useMemo(
    () =>
      createConnectionId
        ? (connectionGroups.find(
            (group) => group.connection.id === createConnectionId,
          ) ?? null)
        : null,
    [connectionGroups, createConnectionId],
  );

  return (
    <div className="flex flex-col gap-5 lg:h-[calc(100dvh-3rem)]">
      <div className="shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">AI 会话</h1>
        <p className="text-sm text-muted-foreground">
          按设备组织 Thread，点击选中后在右侧并排查看上下文、执行过程并继续发送任务。
        </p>
      </div>

      {notice ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800"
        >
          <span>{notice}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setNotice(null)}
          >
            知道了
          </Button>
        </div>
      ) : null}

      {sessionsQuery.error ? (
        <ErrorState
          message={sessionsQuery.error.message}
          onRetry={() => void sessionsQuery.refetch()}
        />
      ) : sessionsQuery.isLoading ? (
        <LoadingBlock label="加载 AI 会话…" />
      ) : connectionGroups.length === 0 ? (
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
                  点击选中，可多选并排查看
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
                  const canManage =
                    isOwner && supportsWebThreadManagement(connection);
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
                          {canManage ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              onClick={() =>
                                setCreateConnectionId(connection.id)
                              }
                              aria-label={`在「${connection.name}」新建 Thread`}
                              title="新建 Thread"
                            >
                              <PlusIcon className="size-3.5" />
                            </Button>
                          ) : null}
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
                            selected={selectedSessionIds.includes(session.id)}
                            onSelect={() => toggleSessionSelected(session.id)}
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
                        ) : groupSessions.length === 0 ? (
                          <button
                            type="button"
                            onClick={() => setPickerConnectionId(connection.id)}
                            className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-3 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-secondary/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                          >
                            <ListFilterIcon className="size-3.5 shrink-0" />
                            暂无 Thread · 点击管理
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
            {selectedSessions.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                  icon={<BotIcon className="size-6" />}
                  title="没有选中的 Thread"
                  description="在左侧点击 Thread 即可打开对话面板，可多选并排查看；再次点击或关闭面板会取消选中，并清除已同步的历史记录。"
                  className="w-full max-w-md"
                />
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col divide-y divide-border lg:flex-row lg:divide-x lg:divide-y-0 lg:overflow-x-auto">
                {selectedSessions.map((session) => (
                  <SessionConversationPanel
                    key={session.id}
                    session={session}
                    onClose={() => deselectSession(session.id)}
                    className="min-w-0 flex-1 lg:min-w-[24rem]"
                  />
                ))}
              </div>
            )}
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
        canManage={
          Boolean(isOwner && pickerGroup) &&
          supportsWebThreadManagement(
            pickerGroup?.connection ?? { bridge_version: null },
          )
        }
        onToggle={setSessionVisible}
        onCreate={() => {
          if (!pickerGroup) return;
          setCreateConnectionId(pickerGroup.connection.id);
          setPickerConnectionId(null);
        }}
        onRename={(session) => {
          setRenameSession(session);
          setPickerConnectionId(null);
        }}
        onDelete={(session) => {
          setDeleteSession(session);
          setPickerConnectionId(null);
        }}
        onOpen={(sessionId) => {
          setSelectedSessionIds((prev) =>
            prev.includes(sessionId) ? prev : [...prev, sessionId],
          );
          setPickerConnectionId(null);
        }}
      />

      {createGroup ? (
        <CreateThreadDialog
          connection={createGroup.connection}
          workingDirectory={
            createGroup.sessions.find((session) => session.working_directory)
              ?.working_directory ?? null
          }
          open
          onOpenChange={(open) => {
            if (!open) setCreateConnectionId(null);
          }}
          onSubmitted={() =>
            setNotice(
              "新建请求已提交；在线 Bridge 处理并同步后，Thread 会自动出现在列表中。",
            )
          }
        />
      ) : null}

      {renameSession ? (
        <RenameThreadDialog
          session={renameSession}
          open
          onOpenChange={(open) => {
            if (!open) setRenameSession(null);
          }}
          onSubmitted={() =>
            setNotice("Thread 名称已更新，并已提交给 Bridge 同步到本机 Codex。")
          }
        />
      ) : null}

      {deleteSession ? (
        <DeleteThreadDialog
          session={deleteSession}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteSession(null);
          }}
          onSubmitted={() => {
            deselectSession(deleteSession.id);
            setNotice(
              "Thread 已从 Console 隐藏，并已提交给在线 Bridge 从本机 Codex 删除。",
            );
          }}
        />
      ) : null}
    </div>
  );
}

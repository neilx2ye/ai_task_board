"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BotIcon } from "lucide-react";

import { SessionConversationPanel } from "@/components/session-conversation-dialog";
import { SessionDirectoryNavigation } from "@/components/session-directory-navigation";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { TaskFormDialog } from "@/components/task-form-dialog";
import { ThreadPickerDialog } from "@/components/thread-picker-dialog";
import {
  CreateThreadDialog,
  DeleteThreadDialog,
  RenameThreadDialog,
} from "@/components/thread-management-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useVisibleSessionIds } from "@/hooks/use-visible-session-ids";
import { useBridgeDirectories } from "@/hooks/use-bridge-directories";
import { sessionQueryKey } from "@/hooks/query-keys";
import { useSessions } from "@/hooks/use-sessions";
import {
  supportsWorkingDirectoryInventory,
  supportsWebThreadManagement,
  useConnections,
} from "@/hooks/use-connections";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  groupSessionsByConnection,
  type SessionConnectionGroup,
  type SessionDirectoryGroup,
} from "@/lib/domain/session-directory-groups";
import {
  findCreatedWebThread,
  type PendingWebThreadCreation,
} from "@/lib/domain/web-thread-creation";
import type { SessionListItem } from "@/lib/types/domain";

type CreateThreadTarget = {
  connectionId: string;
  directoryKey: string | null;
};

type ThreadPickerTarget = {
  connectionId: string;
  directoryId: string;
};

export default function SessionsPage() {
  const sessionsQuery = useSessions();
  const directoriesQuery = useBridgeDirectories();
  const workspaceQuery = useWorkspace();
  const isOwner = workspaceQuery.data?.role === "owner";
  const connectionsQuery = useConnections(isOwner);
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null);
  // 按点选顺序保存选中的 Thread；只有选中的才会挂载面板并同步历史。
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const { visibleIds, setSessionVisible } = useVisibleSessionIds();
  const [pickerTarget, setPickerTarget] =
    useState<ThreadPickerTarget | null>(null);
  const [createTarget, setCreateTarget] =
    useState<CreateThreadTarget | null>(null);
  const [pendingThreadCreation, setPendingThreadCreation] =
    useState<PendingWebThreadCreation | null>(null);
  const [renameSession, setRenameSession] = useState<SessionListItem | null>(
    null,
  );
  const [deleteSession, setDeleteSession] = useState<SessionListItem | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const hierarchyError = sessionsQuery.error ?? directoriesQuery.error;

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
        directoriesQuery.data ?? [],
      ),
    [connectionsQuery.data, directoriesQuery.data, sessions],
  );
  const pickerContext = useMemo(() => {
    if (!pickerTarget) return null;
    const group = connectionGroups.find(
      (candidate) =>
        candidate.connection.id === pickerTarget.connectionId,
    );
    const project = group?.directories.find(
      (candidate) => candidate.id === pickerTarget.directoryId,
    );
    return group && project ? { group, project } : null;
  }, [pickerTarget, connectionGroups]);
  const pickerSupportsDirectories = pickerContext
    ? supportsWorkingDirectoryInventory(pickerContext.group.connection)
    : false;
  const pickerCanCreate = pickerContext
    ? !pickerSupportsDirectories ||
      (pickerContext.project.configured &&
        pickerContext.project.inventoryActive &&
        pickerContext.project.directoryKey !== null)
    : false;
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
      queryKey: sessionQueryKey(sessionId),
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
  const createDialogTarget = useMemo(() => {
    if (!createTarget) return null;
    const group = connectionGroups.find(
      (candidate) => candidate.connection.id === createTarget.connectionId,
    );
    if (!group) return null;

    if (createTarget.directoryKey) {
      const directory = group.directories.find(
        (candidate) =>
          candidate.configured &&
          candidate.inventoryActive &&
          candidate.directoryKey === createTarget.directoryKey,
      );
      if (!directory) return null;
      return {
        group,
        directoryKey: directory.directoryKey,
        directoryName: directory.name,
        workingDirectory: directory.workingDirectory,
      };
    }

    return {
      group,
      directoryKey: null,
      directoryName: null,
      workingDirectory:
        group.sessions.find((session) => session.working_directory)
          ?.working_directory ?? null,
    };
  }, [connectionGroups, createTarget]);

  const openCreateDialog = (
    group: SessionConnectionGroup,
    directory?: SessionDirectoryGroup,
  ) => {
    setCreateTarget({
      connectionId: group.connection.id,
      directoryKey: directory?.directoryKey ?? null,
    });
  };

  useEffect(() => {
    if (!pendingThreadCreation) return;
    const createdSession = findCreatedWebThread(
      sessions,
      pendingThreadCreation,
    );
    if (!createdSession) return;

    // Reconcile after the query-cache render has committed. This both persists
    // sidebar visibility and avoids synchronously cascading another render.
    const timeout = window.setTimeout(() => {
      setSessionVisible(createdSession.id, true);
      setSelectedSessionIds((prev) =>
        prev.includes(createdSession.id) ? prev : [...prev, createdSession.id],
      );
      setPendingThreadCreation(null);
      setNotice(`Thread「${createdSession.name}」已创建并打开。`);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [pendingThreadCreation, sessions, setSessionVisible]);

  return (
    <div className="flex flex-col gap-5 lg:h-[calc(100dvh-3rem)]">
      <div className="shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">AI 会话</h1>
        <p className="text-sm text-muted-foreground">
          按设备和工作目录组织 Thread，点击选中后在右侧并排查看上下文、执行过程并继续发送任务。
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

      {hierarchyError ? (
        <ErrorState
          message={hierarchyError.message}
          onRetry={() => {
            void sessionsQuery.refetch();
            void directoriesQuery.refetch();
          }}
        />
      ) : sessionsQuery.isLoading || directoriesQuery.isLoading ? (
        <LoadingBlock label="加载 AI 会话…" />
      ) : connectionGroups.length === 0 ? (
        <EmptyState
          icon={<BotIcon className="size-6" />}
          title="还没有 AI 会话"
          description="在“AI 连接”页创建连接并配置到 AI 客户端后，客户端注册的会话会显示在这里。"
        />
      ) : (
        <div className="grid min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:grid-cols-[22rem_minmax(0,1fr)]">
          <aside className="border-b border-border lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0">
            <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
              <div>
                <h2 className="text-sm font-semibold">设备、目录与 Threads</h2>
                <p className="text-xs text-muted-foreground">
                  点击选中，可多选并排查看
                </p>
              </div>
              <Badge variant="secondary" className="tabular-nums">
                {sessions.length}
              </Badge>
            </header>

            <SessionDirectoryNavigation
              groups={connectionGroups}
              visibleIds={visibleIds}
              selectedSessionIds={selectedSessionIds}
              isOwner={Boolean(isOwner)}
              onToggleSession={toggleSessionSelected}
              onReserve={setTargetSessionId}
              onManage={(connectionId, directoryId) =>
                setPickerTarget({ connectionId, directoryId })
              }
              onCreate={openCreateDialog}
            />
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
        open={pickerContext !== null}
        onOpenChange={(open) => {
          if (!open) setPickerTarget(null);
        }}
        connection={pickerContext?.group.connection ?? null}
        project={pickerContext?.project ?? null}
        visibleIds={visibleIds}
        canManage={
          Boolean(isOwner && pickerContext) &&
          supportsWebThreadManagement(
            pickerContext?.group.connection ?? { bridge_version: null },
          )
        }
        canCreate={pickerCanCreate}
        onToggle={setSessionVisible}
        onCreate={() => {
          if (!pickerContext) return;
          const directory = pickerSupportsDirectories
            ? pickerContext.project
            : undefined;
          openCreateDialog(pickerContext.group, directory);
          setPickerTarget(null);
        }}
        onRename={(session) => {
          setRenameSession(session);
          setPickerTarget(null);
        }}
        onDelete={(session) => {
          setDeleteSession(session);
          setPickerTarget(null);
        }}
        onOpen={(sessionId) => {
          setSelectedSessionIds((prev) =>
            prev.includes(sessionId) ? prev : [...prev, sessionId],
          );
          setPickerTarget(null);
        }}
      />

      {createDialogTarget ? (
        <CreateThreadDialog
          connection={createDialogTarget.group.connection}
          directoryKey={createDialogTarget.directoryKey}
          directoryName={createDialogTarget.directoryName}
          workingDirectory={createDialogTarget.workingDirectory}
          open
          onOpenChange={(open) => {
            if (!open) setCreateTarget(null);
          }}
          onSubmitted={({ name }) => {
            setPendingThreadCreation({
              connectionId: createDialogTarget.group.connection.id,
              directoryKey: createDialogTarget.directoryKey,
              name,
              existingSessionIds: createDialogTarget.group.sessions.map(
                (session) => session.id,
              ),
            });
            setNotice(
              "新建请求已提交；在线 Bridge 处理并同步后，Thread 会自动出现在列表中。",
            );
          }}
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

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BotIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";

import { ProjectTabBar } from "@/components/project-tab-bar";
import { ProjectBridgeNavigation } from "@/components/project-bridge-navigation";
import type { ProjectEditInput } from "@/components/project-visibility-dialog";
import { ResizableSessionPanel } from "@/components/resizable-session-panel";
import { SessionDirectoryNavigation } from "@/components/session-directory-navigation";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { StopRunningTaskDialog } from "@/components/stop-running-task-dialog";
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
import { useBridgeDirectories } from "@/hooks/use-bridge-directories";
import { useDeleteProject } from "@/hooks/use-delete-project";
import { useHiddenProjects } from "@/hooks/use-hidden-projects";
import { sessionQueryKey } from "@/hooks/query-keys";
import { useSelectedSessionIds } from "@/hooks/use-selected-session-ids";
import { useSelectedProject } from "@/hooks/use-selected-project";
import {
  useMarkSessionCompletionsViewed,
  useSessions,
} from "@/hooks/use-sessions";
import { useUpdateProject } from "@/hooks/use-update-project";
import {
  supportsWorkingDirectoryInventory,
  supportsWebThreadManagement,
  supportsWebThreadRename,
  useConnections,
} from "@/hooks/use-connections";
import { useWorkspace } from "@/hooks/use-workspace";
import { agentDisplayName } from "@/lib/agent-platforms";
import {
  excludeHiddenProjects,
  filterConnectionGroupsByProject,
  groupBridgesByProject,
  groupSessionsByConnection,
  listSessionProjects,
  runtimeConnectionSummary,
  type SessionConnectionGroup,
  type SessionDirectoryGroup,
  type SessionProjectGroup,
} from "@/lib/domain/session-directory-groups";
import {
  summarizeProjectDeleteResults,
  summarizeProjectUpdateResults,
} from "@/lib/domain/project-dispatch-summary";
import {
  findCreatedWebThread,
  type PendingWebThreadCreation,
} from "@/lib/domain/web-thread-creation";
import type { SessionListItem } from "@/lib/types/domain";

type CreateThreadTarget = {
  groupId: string;
  directoryKey: string | null;
};

type ThreadPickerTarget = {
  groupId: string;
  directoryId: string;
};

export default function SessionsPage() {
  const sessionsQuery = useSessions();
  const directoriesQuery = useBridgeDirectories();
  const workspaceQuery = useWorkspace();
  const isOwner = workspaceQuery.data?.role === "owner";
  const connectionsQuery = useConnections(isOwner);
  // 按点选顺序保存选中的 Thread；只有选中的才会挂载面板并同步历史。
  const { selectedSessionIds, setSelectedSessionIds } =
    useSelectedSessionIds();
  const { visibleIds, setSessionVisible } = useVisibleSessionIds();
  // 项目 Tab 过滤：两页共享并用 localStorage 记忆，null 表示「全部」。
  const { selectedProjectId, setSelectedProjectId } = useSelectedProject();
  // 「管理项目」里隐藏的项目：从 Tab 链与「全部」视图剔除（浏览器本地）。
  const { hiddenProjectIds, setProjectHidden } = useHiddenProjects();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const markCompletionsViewed = useMarkSessionCompletionsViewed();
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
  const [stopTarget, setStopTarget] = useState<SessionListItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  // 点击「待查看」且已打开的 Thread 时，用递增的 nonce 触发对应面板强调提示。
  const [panelEmphasis, setPanelEmphasis] = useState<{
    sessionId: string;
    nonce: number;
  } | null>(null);
  const hierarchyError = sessionsQuery.error ?? directoriesQuery.error;

  const handleProjectUpdate = useCallback(
    async (project: SessionProjectGroup, input: ProjectEditInput) => {
      const { results } = await updateProject.mutateAsync({
        working_directory: project.workingDirectory ?? "",
        name: input.name,
        new_working_directory: input.workingDirectory,
      });
      if (!results.some((result) => result.status === "submitted")) {
        throw new Error(summarizeProjectUpdateResults(results));
      }
      const nextId =
        input.workingDirectory === project.workingDirectory
          ? project.id
          : `path:${input.workingDirectory}`;
      if (nextId !== project.id) {
        if (hiddenProjectIds.has(project.id)) {
          setProjectHidden(project.id, false);
          setProjectHidden(nextId, true);
        }
        if (selectedProjectId === project.id) {
          setSelectedProjectId(nextId);
        }
      }
      setNotice(summarizeProjectUpdateResults(results));
    },
    [
      hiddenProjectIds,
      selectedProjectId,
      setProjectHidden,
      setSelectedProjectId,
      updateProject,
    ],
  );

  const handleProjectDelete = useCallback(
    async (project: SessionProjectGroup) => {
      const response = await deleteProject.mutateAsync({
        working_directory: project.workingDirectory ?? "",
      });
      setNotice(summarizeProjectDeleteResults(response));
    },
    [deleteProject, setNotice],
  );

  const sessionCandidates = useMemo(
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
        sessionCandidates,
        (connectionsQuery.data ?? [])
          .filter(
            (connection) =>
              connection.bridge_version !== null ||
              (connection.bridge_versions?.some(
                (entry) => entry.bridge_version !== null,
              ) ??
                false),
          )
          .map((connection) => ({
            id: connection.id,
            name: connection.name,
            platform: connection.platform,
            last_seen_at: connection.last_seen_at,
            bridge_version: connection.bridge_version,
            revoked_at: connection.revoked_at,
            model_catalog: connection.model_catalog,
            model_catalog_updated_at: connection.model_catalog_updated_at,
            bridge_versions: connection.bridge_versions ?? [],
          })),
        directoriesQuery.data ?? [],
      ),
    [connectionsQuery.data, directoriesQuery.data, sessionCandidates],
  );
  const sessions = useMemo(
    () => connectionGroups.flatMap((group) => group.sessions),
    [connectionGroups],
  );
  const allProjects = useMemo(
    () => listSessionProjects(connectionGroups),
    [connectionGroups],
  );
  const dismissedProjectIds = hiddenProjectIds;
  const projects = useMemo(
    () =>
      allProjects.filter((project) => !dismissedProjectIds.has(project.id)),
    [allProjects, dismissedProjectIds],
  );
  const visibleProjectGroups = useMemo(
    () => excludeHiddenProjects(connectionGroups, dismissedProjectIds),
    [connectionGroups, dismissedProjectIds],
  );
  const visibleGroups = useMemo(
    () =>
      filterConnectionGroupsByProject(visibleProjectGroups, selectedProjectId),
    [visibleProjectGroups, selectedProjectId],
  );
  const projectBridgeGroups = useMemo(
    () => groupBridgesByProject(visibleProjectGroups, selectedProjectId),
    [visibleProjectGroups, selectedProjectId],
  );
  const allVisibleSessionCount = useMemo(
    () =>
      visibleProjectGroups.reduce(
        (count, group) => count + group.sessions.length,
        0,
      ),
    [visibleProjectGroups],
  );
  const allRunningTaskCount = useMemo(
    () =>
      visibleProjectGroups.reduce(
        (count, group) =>
          count +
          group.sessions.reduce(
            (sum, session) => sum + (session.running_task_count ?? 0),
            0,
          ),
        0,
      ),
    [visibleProjectGroups],
  );
  const allUnviewedCompletedCount = useMemo(
    () =>
      visibleProjectGroups.reduce(
        (count, group) =>
          count +
          group.sessions.reduce(
            (sum, session) =>
              sum + (session.unviewed_completed_count ?? 0),
            0,
          ),
        0,
      ),
    [visibleProjectGroups],
  );
  const visibleSessions = useMemo(
    () => visibleGroups.flatMap((group) => group.sessions),
    [visibleGroups],
  );

  // 选中的项目随 Bridge 清单消失时，退回「全部」。
  useEffect(() => {
    if (
      hierarchyError ||
      sessionsQuery.isLoading ||
      directoriesQuery.isLoading ||
      selectedProjectId === null ||
      projects.some((project) => project.id === selectedProjectId)
    ) {
      return;
    }
    setSelectedProjectId(null);
  }, [
    directoriesQuery.isLoading,
    hierarchyError,
    projects,
    selectedProjectId,
    sessionsQuery.isLoading,
    setSelectedProjectId,
  ]);
  const pickerContext = useMemo(() => {
    if (!pickerTarget) return null;
    const group = connectionGroups.find(
      (candidate) => candidate.id === pickerTarget.groupId,
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
  // 只展示当前项目下的已选 Thread；其它项目的面板隐藏但保留选中状态，切回即恢复。
  const selectedSessions = useMemo(() => {
    const visibleSessionIds = new Set(
      visibleSessions.map((session) => session.id),
    );
    return selectedSessionIds
      .map((id) => sessions.find((session) => session.id === id))
      .filter(
        (session): session is SessionListItem =>
          session !== undefined && visibleSessionIds.has(session.id),
      );
  }, [selectedSessionIds, sessions, visibleSessions]);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (
      hierarchyError ||
      sessionsQuery.isLoading ||
      directoriesQuery.isLoading
    ) {
      return;
    }

    const availableIds = new Set(sessions.map((session) => session.id));
    const unavailableIds = selectedSessionIds.filter(
      (sessionId) => !availableIds.has(sessionId),
    );
    if (unavailableIds.length === 0) return;

    setSelectedSessionIds((previous) =>
      previous.filter((sessionId) => availableIds.has(sessionId)),
    );
    for (const sessionId of unavailableIds) {
      queryClient.removeQueries({
        queryKey: sessionQueryKey(sessionId),
        exact: true,
      });
    }
  }, [
    directoriesQuery.isLoading,
    hierarchyError,
    queryClient,
    selectedSessionIds,
    sessions,
    sessionsQuery.isLoading,
    setSelectedSessionIds,
  ]);

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
      const selectedSession = sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (
        selectedSession &&
        (selectedSession.unviewed_completed_count ?? 0) > 0
      ) {
        // 面板已打开且有未查看的完成结果：强调面板而不是关闭它，由用户在
        // 面板内交互来清零「待查看」。
        setPanelEmphasis((current) => ({
          sessionId,
          nonce:
            (current?.sessionId === sessionId ? current.nonce : 0) + 1,
        }));
        return;
      }
      deselectSession(sessionId);
    } else {
      const session = sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (session && (session.unviewed_completed_count ?? 0) > 0) {
        markCompletionsViewed.mutate(sessionId);
      }
      setSelectedSessionIds((prev) => [...prev, sessionId]);
    }
  };
  const createDialogTarget = useMemo(() => {
    if (!createTarget) return null;
    const group = connectionGroups.find(
      (candidate) => candidate.id === createTarget.groupId,
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
      groupId: group.id,
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
  }, [
    pendingThreadCreation,
    sessions,
    setSelectedSessionIds,
    setSessionVisible,
  ]);

  return (
    <div className="flex flex-col gap-5 lg:h-[calc(100dvh-3rem)]">
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
        <>
          <ProjectTabBar
            projects={projects}
            allProjects={allProjects}
            hiddenProjectIds={hiddenProjectIds}
            onToggleHiddenProject={setProjectHidden}
            onDeleteProject={handleProjectDelete}
            onUpdateProject={handleProjectUpdate}
            selectedProjectId={selectedProjectId}
            onSelect={setSelectedProjectId}
            totalSessionCount={allVisibleSessionCount}
            totalRunningTaskCount={allRunningTaskCount}
            totalUnviewedCompletedCount={allUnviewedCompletedCount}
            connections={connectionsQuery.data ?? []}
            canManage={Boolean(isOwner)}
            onNotice={setNotice}
          />
          <div
            className={cn(
              "grid min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-[grid-template-columns] duration-200",
              isSidebarCollapsed
                ? "lg:grid-cols-[3.25rem_minmax(0,1fr)]"
                : "lg:grid-cols-[22rem_minmax(0,1fr)]",
            )}
          >
            <aside
              aria-label="会话导航侧边栏"
              className="border-b border-border lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0"
            >
              <header
                className={cn(
                  "flex items-center gap-2 border-b border-border py-3",
                  isSidebarCollapsed
                    ? "justify-end px-3 lg:justify-center lg:px-2"
                    : "justify-between px-3",
                )}
              >
                {isSidebarCollapsed ? null : (
                  <div>
                    <h2 className="text-sm font-semibold">
                      {selectedProjectId === null
                        ? "设备、目录与 Threads"
                        : "项目、Bridge 与 Threads"}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      点击选中，可多选并排查看
                    </p>
                  </div>
                )}
                <div className="flex shrink-0 items-center gap-1">
                  {isSidebarCollapsed ? null : (
                    <Badge variant="secondary" className="tabular-nums">
                      {visibleSessions.length}
                    </Badge>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-controls="session-directory-navigation"
                    aria-expanded={!isSidebarCollapsed}
                    aria-label={
                      isSidebarCollapsed ? "展开会话侧边栏" : "折叠会话侧边栏"
                    }
                    title={isSidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
                    onClick={() =>
                      setIsSidebarCollapsed((collapsed) => !collapsed)
                    }
                  >
                    {isSidebarCollapsed ? (
                      <PanelLeftOpenIcon />
                    ) : (
                      <PanelLeftCloseIcon />
                    )}
                  </Button>
                </div>
              </header>

              <div
                id="session-directory-navigation"
                hidden={isSidebarCollapsed}
              >
                {selectedProjectId === null ? (
                  <SessionDirectoryNavigation
                    groups={visibleGroups}
                    visibleIds={visibleIds}
                    selectedSessionIds={selectedSessionIds}
                    isOwner={Boolean(isOwner)}
                    onToggleSession={toggleSessionSelected}
                    onManage={(groupId, directoryId) =>
                      setPickerTarget({ groupId, directoryId })
                    }
                    onCreate={openCreateDialog}
                    onStopRunningTask={setStopTarget}
                  />
                ) : (
                  <ProjectBridgeNavigation
                    projects={projectBridgeGroups}
                    visibleIds={visibleIds}
                    selectedSessionIds={selectedSessionIds}
                    isOwner={Boolean(isOwner)}
                    onToggleSession={toggleSessionSelected}
                    onManage={(groupId, directoryId) =>
                      setPickerTarget({ groupId, directoryId })
                    }
                    onCreate={openCreateDialog}
                    onStopRunningTask={setStopTarget}
                  />
                )}
              </div>
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
                    <ResizableSessionPanel
                      key={session.id}
                      session={session}
                      emphasisNonce={
                        panelEmphasis?.sessionId === session.id
                          ? panelEmphasis.nonce
                          : 0
                      }
                      onClose={() => deselectSession(session.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <ThreadPickerDialog
        open={pickerContext !== null}
        onOpenChange={(open) => {
          if (!open) setPickerTarget(null);
        }}
        connection={
          pickerContext ? runtimeConnectionSummary(pickerContext.group) : null
        }
        project={pickerContext?.project ?? null}
        visibleIds={visibleIds}
        canManage={
          Boolean(isOwner && pickerContext) &&
          supportsWebThreadManagement(
            pickerContext?.group.connection ?? { bridge_version: null },
          )
        }
        canRename={
          Boolean(isOwner && pickerContext) &&
          supportsWebThreadRename(
            pickerContext
              ? runtimeConnectionSummary(pickerContext.group)
              : { bridge_version: null, platform: "" },
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
        onBulkDeleteSubmitted={({ deletedCount, skippedCount }) => {
          setNotice(
            skippedCount > 0
              ? `已提交 ${deletedCount} 个未勾选 Thread 的删除请求；另有 ${skippedCount} 个因有任务或已离开设备清单而跳过。`
              : `已提交 ${deletedCount} 个未勾选 Thread 的删除请求。`,
          );
        }}
        onOpen={(sessionId) => {
          const session = sessions.find(
            (candidate) => candidate.id === sessionId,
          );
          if (session && (session.unviewed_completed_count ?? 0) > 0) {
            markCompletionsViewed.mutate(sessionId);
          }
          setSelectedSessionIds((prev) =>
            prev.includes(sessionId) ? prev : [...prev, sessionId],
          );
          setPickerTarget(null);
        }}
      />

      {createDialogTarget ? (
        <CreateThreadDialog
          connection={createDialogTarget.group.connection}
          runtimePlatform={createDialogTarget.group.platform}
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
              platform: createDialogTarget.group.platform,
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
            setNotice(
              `Thread 名称已更新，并已提交给 Bridge 同步到本机 ${agentDisplayName(
                renameSession.platform,
              )}。`,
            )
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
              `Thread 已从 Console 隐藏，并已提交给在线 Bridge 从本机 ${agentDisplayName(
                deleteSession.platform,
              )} 删除。`,
            );
          }}
        />
      ) : null}

      {stopTarget ? (
        <StopRunningTaskDialog
          session={stopTarget}
          open
          onOpenChange={(open) => {
            if (!open) setStopTarget(null);
          }}
          onStopped={setNotice}
        />
      ) : null}
    </div>
  );
}

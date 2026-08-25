"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BotIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";

import { ProjectBridgeNavigation } from "@/components/project-bridge-navigation";
import { ProjectPlanningView } from "@/components/project-planning-view";
import { ProjectTabBar } from "@/components/project-tab-bar";
import type { ProjectEditInput } from "@/components/project-visibility-dialog";
import { SessionDirectoryNavigation } from "@/components/session-directory-navigation";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { ThreadPickerDialog } from "@/components/thread-picker-dialog";
import {
  CreateThreadDialog,
  DeleteThreadDialog,
  RenameThreadDialog,
} from "@/components/thread-management-dialogs";
import { ThreadPlanningNotesEditor } from "@/components/thread-planning-notes-editor";
import { TurnPlanPanel } from "@/components/turn-plan-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/utils";
import { useVisibleSessionIds } from "@/hooks/use-visible-session-ids";
import { useBridgeDirectories } from "@/hooks/use-bridge-directories";
import { useDeleteProject } from "@/hooks/use-delete-project";
import { useHiddenProjects } from "@/hooks/use-hidden-projects";
import { useSelectedProject } from "@/hooks/use-selected-project";
import {
  useMarkSessionCompletionsViewed,
  useSessions,
} from "@/hooks/use-sessions";
import { useUpdateProject } from "@/hooks/use-update-project";
import {
  supportsWebThreadManagement,
  supportsWebThreadRename,
  supportsWorkingDirectoryInventory,
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
  sessionProjectIdForDirectory,
  type SessionConnectionGroup,
  type SessionDirectoryGroup,
  type SessionProjectBridge,
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

/**
 * 任务规划工作台：与会话页共用「设备 → 项目目录 → Thread」导航。
 * 项目级规划按路径跨 Bridge 共享；每个 Thread 另有只属于该会话的思考笔记
 * 和 Turn 规划链，两者与项目规划互不混用。
 */
export default function PlanningPage() {
  const sessionsQuery = useSessions();
  const markCompletionsViewed = useMarkSessionCompletionsViewed();
  const directoriesQuery = useBridgeDirectories();
  const workspaceQuery = useWorkspace();
  const isOwner = workspaceQuery.data?.role === "owner";
  const connectionsQuery = useConnections(isOwner);
  // 规划是单线程工作台：一次只打开一个 Thread 的规划面板。
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  // 或者直接选中一个项目，查看跨 Bridge 的项目级思考与规划。
  const [selectedPlanningProjectId, setSelectedPlanningProjectId] = useState<
    string | null
  >(null);
  const { visibleIds, setSessionVisible } = useVisibleSessionIds();
  // 项目 Tab 过滤：与会话页共享并用 localStorage 记忆，null 表示「全部」。
  const { selectedProjectId, setSelectedProjectId } = useSelectedProject();
  // 「管理项目」里隐藏的项目：从 Tab 链与「全部」视图剔除（浏览器本地）。
  const { hiddenProjectIds, setProjectHidden } = useHiddenProjects();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const [pickerTarget, setPickerTarget] = useState<ThreadPickerTarget | null>(
    null,
  );
  const [createTarget, setCreateTarget] = useState<CreateThreadTarget | null>(
    null,
  );
  const [pendingThreadCreation, setPendingThreadCreation] =
    useState<PendingWebThreadCreation | null>(null);
  const [renameSession, setRenameSession] = useState<SessionListItem | null>(
    null,
  );
  const [deleteSession, setDeleteSession] = useState<SessionListItem | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
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
        if (selectedPlanningProjectId === project.id) {
          setSelectedPlanningProjectId(nextId);
        }
      }
      setNotice(summarizeProjectUpdateResults(results));
    },
    [
      hiddenProjectIds,
      selectedPlanningProjectId,
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

  // 选中态从过滤后的层级派生：切换到其它项目 Tab 时隐藏（id 保留，切回即恢复）。
  const selectedSession = useMemo(
    () =>
      visibleSessions.find((session) => session.id === selectedSessionId) ??
      null,
    [selectedSessionId, visibleSessions],
  );
  const projectPlanningContext = useMemo<{
    project: SessionProjectGroup;
    bridges: SessionProjectBridge[];
  } | null>(() => {
    if (!selectedPlanningProjectId) return null;
    const project = allProjects.find(
      (candidate) => candidate.id === selectedPlanningProjectId,
    );
    // 项目暂时从 Bridge 清单消失时回落到空状态；id 保留，项目回来后原地恢复。
    if (!project) return null;

    // 跨 Bridge 汇总：同一项目路径下的所有 Bridge 都纳入项目级规划。
    const bridges: SessionProjectBridge[] = [];
    for (const group of connectionGroups) {
      for (const directory of group.directories) {
        if (
          sessionProjectIdForDirectory(directory) ===
          selectedPlanningProjectId
        ) {
          bridges.push({
            groupId: group.id,
            platform: group.platform,
            connection: group.connection,
            directory,
          });
        }
      }
    }
    return { project, bridges };
  }, [allProjects, connectionGroups, selectedPlanningProjectId]);
  const selectedContext = useMemo(() => {
    if (!selectedSession) return null;
    const group = visibleGroups.find(
      (candidate) =>
        candidate.sessions.some((session) => session.id === selectedSession.id),
    );
    const directory = group?.directories.find((candidate) =>
      candidate.sessions.some((session) => session.id === selectedSession.id),
    );
    return group && directory ? { group, directory } : null;
  }, [visibleGroups, selectedSession]);
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

  // Thread 被删除或离开清单时，selectedSession 派生为 null 并回到空状态；
  // 这里不手动清理 id，Thread 因清单抖动短暂消失再回来时面板可以原地恢复。
  const toggleSessionSelected = (sessionId: string) => {
    setSelectedPlanningProjectId(null);
    if (selectedSessionId !== sessionId) {
      const session = sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (session && (session.unviewed_completed_count ?? 0) > 0) {
        markCompletionsViewed.mutate(sessionId);
      }
    }
    setSelectedSessionId((previous) =>
      previous === sessionId ? null : sessionId,
    );
  };
  const toggleProjectPlanning = (projectId: string) => {
    setSelectedSessionId(null);
    setSelectedPlanningProjectId((previous) =>
      previous === projectId ? null : projectId,
    );
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

  // 与会话页一致：Bridge 同步出新 Thread 后自动选中并提示。
  useEffect(() => {
    if (!pendingThreadCreation) return;
    const createdSession = findCreatedWebThread(
      sessions,
      pendingThreadCreation,
    );
    if (!createdSession) return;

    const timeout = window.setTimeout(() => {
      setSessionVisible(createdSession.id, true);
      setSelectedPlanningProjectId(null);
      setSelectedSessionId(createdSession.id);
      setPendingThreadCreation(null);
      setNotice(`Thread「${createdSession.name}」已创建并打开。`);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [pendingThreadCreation, sessions, setSessionVisible]);

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
              aria-label="规划导航侧边栏"
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
                      选中项目看共享规划，选中 Thread 写独立规划并编排 Turn 链
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
                    aria-controls="planning-directory-navigation"
                    aria-expanded={!isSidebarCollapsed}
                    aria-label={
                      isSidebarCollapsed ? "展开规划侧边栏" : "折叠规划侧边栏"
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
                id="planning-directory-navigation"
                hidden={isSidebarCollapsed}
              >
                {selectedProjectId === null ? (
                  <SessionDirectoryNavigation
                    groups={visibleGroups}
                    visibleIds={visibleIds}
                    selectedSessionIds={
                      selectedSessionId ? [selectedSessionId] : []
                    }
                    isOwner={Boolean(isOwner)}
                    onToggleSession={toggleSessionSelected}
                    onManage={(groupId, directoryId) =>
                      setPickerTarget({ groupId, directoryId })
                    }
                    onCreate={openCreateDialog}
                    selectedProjectId={selectedPlanningProjectId}
                    onSelectProject={toggleProjectPlanning}
                  />
                ) : (
                  <ProjectBridgeNavigation
                    projects={projectBridgeGroups}
                    visibleIds={visibleIds}
                    selectedSessionIds={
                      selectedSessionId ? [selectedSessionId] : []
                    }
                    isOwner={Boolean(isOwner)}
                    onToggleSession={toggleSessionSelected}
                    onManage={(groupId, directoryId) =>
                      setPickerTarget({ groupId, directoryId })
                    }
                    onCreate={openCreateDialog}
                    selectedProjectId={selectedPlanningProjectId}
                    onSelectProject={toggleProjectPlanning}
                  />
                )}
              </div>
            </aside>

            <div className="min-h-0 lg:overflow-y-auto">
              {selectedSession ? (
                <div className="flex min-h-full flex-col gap-4 p-4 lg:p-6">
                  <header className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <h1 className="truncate text-base font-semibold">
                        {selectedSession.name}
                      </h1>
                      <p className="truncate text-xs text-muted-foreground">
                        {selectedSession.working_directory ??
                          selectedContext?.directory.workingDirectory ??
                          selectedContext?.directory.name ??
                          ""}
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0">
                      {agentDisplayName(selectedSession.platform)}
                    </Badge>
                  </header>

                  <ThreadPlanningNotesEditor
                    key={selectedSession.id}
                    sessionId={selectedSession.id}
                    sessionName={selectedSession.name}
                  />

                  <TurnPlanPanel session={selectedSession} />
                </div>
              ) : projectPlanningContext ? (
                <ProjectPlanningView
                  project={projectPlanningContext.project}
                  bridges={projectPlanningContext.bridges}
                  onOpenThread={(sessionId) => {
                    setSelectedPlanningProjectId(null);
                    setSelectedSessionId(sessionId);
                  }}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6">
                  <EmptyState
                    icon={<BotIcon className="size-6" />}
                    title="没有选中的项目或 Thread"
                    description="在左侧点击项目，可以记录整个项目跨 Bridge 共享的思考与规划；点击一个 Thread，则编辑它自己的规划笔记，并为它编排独立的 Turn 规划链。"
                    className="w-full max-w-md"
                  />
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
          setSelectedPlanningProjectId(null);
          setSelectedSessionId(sessionId);
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
            if (deleteSession.id === selectedSessionId) {
              setSelectedSessionId(null);
            }
            setNotice(
              `Thread 已从 Console 隐藏，并已提交给在线 Bridge 从本机 ${agentDisplayName(
                deleteSession.platform,
              )} 删除。`,
            );
          }}
        />
      ) : null}
    </div>
  );
}

"use client";

import { FolderIcon, ListFilterIcon, PlusIcon } from "lucide-react";

import { connectionColorMeta } from "@/components/connection-meta";
import { sessionStatusMeta, TASK_STATUS_META } from "@/components/task-meta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/utils";
import {
  supportsWorkingDirectoryInventory,
  supportsWebThreadManagement,
} from "@/hooks/use-connections";
import {
  bridgeKindDisplayName,
  connectionPlatformLabel,
} from "@/lib/agent-platforms";
import { isConnectionAlive } from "@/lib/domain/session-presence";
import { sessionProjectIdForDirectory } from "@/lib/domain/session-directory-groups";
import type {
  SessionConnectionGroup,
  SessionDirectoryGroup,
} from "@/lib/domain/session-directory-groups";
import type { SessionListItem } from "@/lib/types/domain";

type SessionDirectoryNavigationProps = {
  groups: SessionConnectionGroup[];
  visibleIds: ReadonlySet<string>;
  selectedSessionIds: readonly string[];
  isOwner: boolean;
  onToggleSession: (sessionId: string) => void;
  onManage: (groupId: string, directoryId: string) => void;
  onCreate: (
    group: SessionConnectionGroup,
    directory?: SessionDirectoryGroup,
  ) => void;
  /**
   * 可选（规划页）：提供后目录行本身变为可选中，按项目（路径）跨 Bridge
   * 选中项目级规划；同一路径在不同 Bridge 下的目录行会同时高亮。
   */
  selectedProjectId?: string | null;
  onSelectProject?: (projectId: string) => void;
};

export function SessionListRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const statusMeta = sessionStatusMeta(session);
  const task = session.current_task;
  const lastCompletedTask = session.last_completed_task;
  const taskStatusMeta = task
    ? TASK_STATUS_META[
        task.awaiting_user_input ? "waiting_user" : task.status
      ]
    : null;
  const model = session.configured_model ?? session.model;

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
          {session.platform}
          {model ? ` · ${model}` : ""}
          {session.configured_reasoning_effort
            ? ` / ${session.configured_reasoning_effort}`
            : ""}
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
          ) : lastCompletedTask ? (
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                {lastCompletedTask.title}
              </span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">当前空闲</span>
          )}
        </div>

        <p className="mt-2 text-xs text-muted-foreground tabular-nums">
          已预留 {session.queued_task_count} 项
        </p>
      </button>
    </div>
  );
}

function DirectorySection({
  group,
  directory,
  canCreate,
  visibleIds,
  selectedSessionIds,
  onToggleSession,
  onManage,
  onCreate,
  selectedProjectId,
  onSelectProject,
}: {
  group: SessionConnectionGroup;
  directory: SessionDirectoryGroup;
  canCreate: boolean;
  visibleIds: ReadonlySet<string>;
  selectedSessionIds: readonly string[];
  onToggleSession: (sessionId: string) => void;
  onManage: (groupId: string, directoryId: string) => void;
  onCreate: (
    group: SessionConnectionGroup,
    directory: SessionDirectoryGroup,
  ) => void;
  selectedProjectId?: string | null;
  onSelectProject?: (projectId: string) => void;
}) {
  const visibleSessions = directory.sessions.filter((session) =>
    visibleIds.has(session.id),
  );
  const headingId = `directory-${group.id}-${
    directory.directoryKey ?? directory.sessions[0]?.id ?? "unassigned"
  }`;
  const projectId = sessionProjectIdForDirectory(directory);
  const directorySelected = selectedProjectId === projectId;

  const directoryName = (
    <>
      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <h4
        id={headingId}
        className="min-w-0 flex-1 truncate text-left text-xs font-medium"
      >
        {directory.name}
      </h4>
    </>
  );

  return (
    <section
      aria-labelledby={headingId}
      className="border-b border-border/70 last:border-b-0"
    >
      <header
        className={cn(
          "px-3 py-2 pl-4 transition-colors",
          directorySelected ? "bg-indigo-50/80" : "bg-secondary/25",
        )}
      >
        <div className="flex items-center gap-2">
          {onSelectProject ? (
            <button
              type="button"
              aria-pressed={directorySelected}
              aria-label={`${directorySelected ? "取消选中" : "选中"}项目「${directory.name}」`}
              title={directorySelected ? "取消选中" : "打开项目级规划"}
              onClick={() => onSelectProject(projectId)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {directoryName}
            </button>
          ) : (
            directoryName
          )}
          <Badge variant="outline" className="tabular-nums">
            {directory.sessions.length}
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2"
            onClick={() => onManage(group.id, directory.id)}
            aria-label={`管理项目「${directory.name}」的 Threads`}
            title={`管理「${directory.name}」的 Threads`}
          >
            <ListFilterIcon className="size-3.5" />
            管理 Threads
          </Button>
          {canCreate ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() => onCreate(group, directory)}
              aria-label={`在工作目录「${directory.name}」新建 Thread`}
              title="在此工作目录新建 Thread"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <p
          className="mt-0.5 truncate pl-5 text-[11px] text-muted-foreground"
          title={directory.workingDirectory ?? undefined}
        >
          {directory.workingDirectory ?? "无工作目录信息"}
        </p>
      </header>
      <div className="ml-3 border-l border-border/70">
        {visibleSessions.map((session) => (
          <SessionListRow
            key={session.id}
            session={session}
            selected={selectedSessionIds.includes(session.id)}
            onSelect={() => onToggleSession(session.id)}
          />
        ))}
        {directory.sessions.length === 0 ? (
          <p className="px-3 py-2.5 text-xs text-muted-foreground">
            暂无 Thread
          </p>
        ) : visibleSessions.length === 0 ? (
          <p className="px-3 py-2.5 text-xs text-muted-foreground">
            此项目的 Thread 已全部收纳
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ConnectionSection({
  group,
  visibleIds,
  selectedSessionIds,
  isOwner,
  onToggleSession,
  onManage,
  onCreate,
  selectedProjectId,
  onSelectProject,
}: Omit<SessionDirectoryNavigationProps, "groups"> & {
  group: SessionConnectionGroup;
}) {
  const { connection, sessions, directories } = group;
  const visibleDirectories = directories.filter(
    (directory) => directory.inventoryActive,
  );
  const deviceOnline = isConnectionAlive(connection);
  const canManage = isOwner && supportsWebThreadManagement(connection);
  const supportsDirectories = supportsWorkingDirectoryInventory(connection);
  const canCreateWithoutDirectory =
    canManage &&
    (!supportsDirectories ||
      !visibleDirectories.some((directory) => directory.configured));

  return (
    <section
      aria-labelledby={`connection-${group.id}`}
      className="border-b border-border last:border-b-0"
    >
      <header className="bg-muted/40 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            title="与 Thread 窗口顶部标识条同色"
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              connectionColorMeta(connection.id).dotClass,
            )}
          />
          <h3
            id={`connection-${group.id}`}
            className="min-w-0 flex-1 truncate text-xs font-semibold"
          >
            {connection.name}
          </h3>
          {group.platform ? (
            <Badge
              variant="outline"
              className="shrink-0 text-muted-foreground"
            >
              {bridgeKindDisplayName(group.platform)}
            </Badge>
          ) : null}
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
            {sessions.length}
          </Badge>
          {canCreateWithoutDirectory ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() => onCreate(group)}
              aria-label={`在「${connection.name}」新建 Thread`}
              title="新建 Thread"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {connectionPlatformLabel(connection.platform)}
          {connection.bridge_version
            ? ` · Bridge ${connection.bridge_version}`
            : ""}
        </p>
      </header>

      <div>
        {visibleDirectories.map((directory) => (
          <DirectorySection
            key={directory.id}
            group={group}
            directory={directory}
            canCreate={
              canManage &&
              supportsDirectories &&
              directory.configured &&
              directory.inventoryActive &&
              directory.directoryKey !== null
            }
            visibleIds={visibleIds}
            selectedSessionIds={selectedSessionIds}
            onToggleSession={onToggleSession}
            onManage={onManage}
            onCreate={onCreate}
            selectedProjectId={selectedProjectId}
            onSelectProject={onSelectProject}
          />
        ))}
        {visibleDirectories.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            暂无工作目录或 Thread
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function SessionDirectoryNavigation({
  groups,
  ...props
}: SessionDirectoryNavigationProps) {
  return (
    <nav aria-label="设备、工作目录与 Thread 列表">
      {groups.map((group) => (
        <ConnectionSection key={group.id} group={group} {...props} />
      ))}
    </nav>
  );
}

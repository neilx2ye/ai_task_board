"use client";

import { FolderIcon, ListFilterIcon, PlusIcon } from "lucide-react";

import { connectionColorMeta } from "@/components/connection-meta";
import { SessionListRow } from "@/components/session-directory-navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/utils";
import {
  supportsWorkingDirectoryInventory,
  supportsWebThreadManagement,
} from "@/hooks/use-connections";
import { agentDisplayName } from "@/lib/agent-platforms";
import { isConnectionAlive } from "@/lib/domain/session-presence";
import type {
  SessionConnectionGroup,
  SessionDirectoryGroup,
  SessionProjectBridge,
  SessionProjectBridgeGroup,
} from "@/lib/domain/session-directory-groups";

type ProjectBridgeNavigationProps = {
  /** 项目优先分组；按项目 Tab 过滤后通常只有一个项目。 */
  projects: SessionProjectBridgeGroup[];
  visibleIds: ReadonlySet<string>;
  selectedSessionIds: readonly string[];
  isOwner: boolean;
  onToggleSession: (sessionId: string) => void;
  onManage: (connectionId: string, directoryId: string) => void;
  onCreate: (
    group: SessionConnectionGroup,
    directory?: SessionDirectoryGroup,
  ) => void;
  /**
   * 可选（规划页）：项目头变为可选中，打开跨 Bridge 的项目级规划视图。
   * 项目级规划不挂在单个 Bridge 上，因此 Bridge 行本身不可选中。
   */
  selectedProjectId?: string | null;
  onSelectProject?: (projectId: string) => void;
};

function BridgeSection({
  bridge,
  visibleIds,
  selectedSessionIds,
  isOwner,
  onToggleSession,
  onManage,
  onCreate,
}: {
  bridge: SessionProjectBridge;
  visibleIds: ReadonlySet<string>;
  selectedSessionIds: readonly string[];
  isOwner: boolean;
  onToggleSession: (sessionId: string) => void;
  onManage: (connectionId: string, directoryId: string) => void;
  onCreate: (
    group: SessionConnectionGroup,
    directory?: SessionDirectoryGroup,
  ) => void;
}) {
  const { connection, directory } = bridge;
  const headingId = `bridge-${connection.id}-${
    directory.directoryKey ?? directory.sessions[0]?.id ?? "unassigned"
  }`;
  const visibleSessions = directory.sessions.filter((session) =>
    visibleIds.has(session.id),
  );
  const deviceOnline = isConnectionAlive(connection);
  const canManage = isOwner && supportsWebThreadManagement(connection);
  const supportsDirectories = supportsWorkingDirectoryInventory(connection);
  const canCreateWithDirectory =
    canManage &&
    supportsDirectories &&
    directory.configured &&
    directory.inventoryActive &&
    directory.directoryKey !== null;
  // 旧版 Bridge 没有目录清单：沿用在连接上直接新建 Thread 的入口。
  const canCreateWithoutDirectory =
    canManage && (!supportsDirectories || !directory.configured);
  const group: SessionConnectionGroup = {
    connection,
    sessions: directory.sessions,
    directories: [directory],
  };

  return (
    <section
      aria-labelledby={headingId}
      className="border-b border-border/70 last:border-b-0"
    >
      <header className="bg-muted/40 px-3 py-2.5">
        {/* 第一行：Bridge 身份与运行状态。 */}
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            title="与 Thread 窗口顶部标识条同色"
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              connectionColorMeta(connection.id).dotClass,
            )}
          />
          <h4
            id={headingId}
            className="min-w-0 flex-1 truncate text-xs font-semibold"
          >
            {connection.name}
          </h4>
          <Badge variant="outline" className="shrink-0">
            {agentDisplayName(connection.platform)}
          </Badge>
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
        </div>
        {/* 第二行：Bridge 版本、Thread 数与 Thread 管理操作。 */}
        <div className="mt-1.5 flex items-center gap-1.5 pl-5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {connection.bridge_version
              ? `Bridge ${connection.bridge_version}`
              : ""}
          </span>
          <Badge
            variant="outline"
            className="shrink-0 tabular-nums"
            title="Thread 数"
          >
            {directory.sessions.length}
          </Badge>
          {canManage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2"
              onClick={() => onManage(connection.id, directory.id)}
              aria-label={`管理项目「${directory.name}」在 Bridge「${connection.name}」的 Threads`}
              title={`管理「${connection.name}」的 Threads`}
            >
              <ListFilterIcon className="size-3.5" />
              管理 Threads
            </Button>
          ) : null}
          {canCreateWithDirectory || canCreateWithoutDirectory ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() =>
                onCreate(group, canCreateWithDirectory ? directory : undefined)
              }
              aria-label={`在 Bridge「${connection.name}」的工作目录「${directory.name}」新建 Thread`}
              title="在此工作目录新建 Thread"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
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

function ProjectSection({
  project,
  selectedProjectId,
  onSelectProject,
  ...bridgeProps
}: {
  project: SessionProjectBridgeGroup;
} & Omit<
  ProjectBridgeNavigationProps,
  "projects"
>) {
  const headingId = `project-${project.id}`;
  const selected = selectedProjectId === project.id;

  return (
    <section
      aria-labelledby={headingId}
      className="border-b border-border last:border-b-0"
    >
      <header
        className={cn(
          "bg-secondary/25 px-3 py-2.5 pl-4",
          selected && "bg-indigo-50/80",
        )}
      >
        {onSelectProject ? (
          <button
            type="button"
            aria-pressed={selected}
            aria-label={`${selected ? "取消选中" : "选中"}项目「${project.name}」的项目规划`}
            title={selected ? "取消选中" : "打开项目级规划"}
            onClick={() => onSelectProject(project.id)}
            className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <h3
              id={headingId}
              className="min-w-0 flex-1 truncate text-xs font-semibold"
            >
              {project.name}
            </h3>
            <Badge variant="outline" className="shrink-0 tabular-nums">
              {project.sessionCount}
            </Badge>
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <h3
              id={headingId}
              className="min-w-0 flex-1 truncate text-xs font-semibold"
            >
              {project.name}
            </h3>
            <Badge variant="outline" className="shrink-0 tabular-nums">
              {project.sessionCount}
            </Badge>
          </div>
        )}
        <p
          className="mt-0.5 truncate pl-5 text-[11px] text-muted-foreground"
          title={project.workingDirectory ?? undefined}
        >
          {project.workingDirectory ?? "无工作目录信息"}
        </p>
      </header>
      <div>
        {project.bridges.map((bridge) => (
          <BridgeSection
            key={`${bridge.connection.id}:${bridge.directory.id}`}
            bridge={bridge}
            {...bridgeProps}
          />
        ))}
        {project.bridges.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            暂无 Bridge 对这个项目地址有权限
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 项目优先导航：选中项目 Tab 后按「项目 → Bridges → Threads」展示。
 * 只有对该项目地址（working directory）有权限的 Bridge 会出现在项目下；
 * 「全部」视图继续使用设备优先的 SessionDirectoryNavigation。
 */
export function ProjectBridgeNavigation({
  projects,
  ...props
}: ProjectBridgeNavigationProps) {
  return (
    <nav aria-label="项目、Bridge 与 Thread 列表">
      {projects.map((project) => (
        <ProjectSection key={project.id} project={project} {...props} />
      ))}
    </nav>
  );
}

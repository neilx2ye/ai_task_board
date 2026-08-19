"use client";

import { useState } from "react";
import {
  FolderIcon,
  LayersIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { CreateProjectDialog } from "@/components/create-project-dialog";
import {
  ProjectVisibilityDialog,
  type ProjectEditInput,
} from "@/components/project-visibility-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/utils";
import type { PublicConnection } from "@/hooks/use-connections";
import type { SessionProjectGroup } from "@/lib/domain/session-directory-groups";

type ProjectTabBarProps = {
  /** 可见项目（已剔除隐藏），渲染为 Tab。 */
  projects: SessionProjectGroup[];
  /** 全部项目（含隐藏），供管理对话框使用。 */
  allProjects: SessionProjectGroup[];
  hiddenProjectIds: ReadonlySet<string>;
  onToggleHiddenProject: (projectId: string, hidden: boolean) => void;
  /** 管理对话框中删除项目的服务端操作。 */
  onDeleteProject: (project: SessionProjectGroup) => Promise<void>;
  /** 管理对话框中保存项目名称/路径的编辑结果。 */
  onUpdateProject: (
    project: SessionProjectGroup,
    input: ProjectEditInput,
  ) => Promise<void>;
  /** null 表示选中「全部」。 */
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  /** 「全部」Tab 上展示的 Thread 数（不含隐藏项目）。 */
  totalSessionCount: number;
  /** 「全部」Tab 上正在运行的任务数（不含隐藏项目）。 */
  totalRunningTaskCount: number;
  /** 「全部」Tab 上已完成待查看的任务数（不含隐藏项目）。 */
  totalUnviewedCompletedCount: number;
  /** 创建项目对话框用的连接清单（按设备分组）。 */
  connections: PublicConnection[];
  canManage: boolean;
  onNotice: (message: string) => void;
};

function ProjectTab({
  selected,
  onSelect,
  label,
  totalCount,
  runningCount,
  unviewedCount,
  title,
  icon,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  totalCount: number;
  runningCount: number;
  unviewedCount: number;
  title?: string;
  icon: React.ReactNode;
}) {
  const hasActivity = runningCount > 0 || unviewedCount > 0;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      title={title}
      onClick={onSelect}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        selected
          ? "border-indigo-200 bg-indigo-50/80 text-foreground"
          : "border-border text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
      )}
    >
      {icon}
      <span className="max-w-40 truncate">{label}</span>
      {hasActivity ? (
        <span className="flex shrink-0 items-center gap-1">
          {runningCount > 0 ? (
            <Badge
              title={`${runningCount} 个任务正在运行`}
              className="border-indigo-300 bg-indigo-100 text-indigo-800 tabular-nums"
            >
              {runningCount} 运行
            </Badge>
          ) : null}
          {unviewedCount > 0 ? (
            <Badge
              title={`${unviewedCount} 个任务已完成，尚未查看`}
              className="border-amber-200 bg-amber-50 text-amber-800 tabular-nums"
            >
              {unviewedCount} 待查看
            </Badge>
          ) : null}
        </span>
      ) : (
        <Badge variant="outline" className="tabular-nums">
          {totalCount}
        </Badge>
      )}
    </button>
  );
}

/**
 * 项目 Tab 链条：按项目过滤下方的 Bridge / Thread 层级。
 * 同一个 working directory 跨 Bridge 合并为一个 Tab，「全部」表示不过滤；
 * 尾部提供新建项目与项目展示管理入口。
 */
export function ProjectTabBar({
  projects,
  allProjects,
  hiddenProjectIds,
  onToggleHiddenProject,
  onDeleteProject,
  onUpdateProject,
  selectedProjectId,
  onSelect,
  totalSessionCount,
  totalRunningTaskCount,
  totalUnviewedCompletedCount,
  connections,
  canManage,
  onNotice,
}: ProjectTabBarProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <div
        role="tablist"
        aria-label="按项目过滤"
        className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5"
      >
        <ProjectTab
          selected={selectedProjectId === null}
          onSelect={() => onSelect(null)}
          label="全部"
          totalCount={totalSessionCount}
          runningCount={totalRunningTaskCount}
          unviewedCount={totalUnviewedCompletedCount}
          title="显示所有项目的 Bridge 与 Thread"
          icon={<LayersIcon className="size-3.5 shrink-0" />}
        />
        {projects.map((project) => (
          <ProjectTab
            key={project.id}
            selected={selectedProjectId === project.id}
            onSelect={() => onSelect(project.id)}
            label={project.name}
            totalCount={project.sessionCount}
            runningCount={project.runningTaskCount}
            unviewedCount={project.unviewedCompletedCount}
            title={project.workingDirectory ?? project.name}
            icon={<FolderIcon className="size-3.5 shrink-0" />}
          />
        ))}
      </div>

      {canManage ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon className="size-3.5" />
            新建项目
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1"
            onClick={() => setManageOpen(true)}
          >
            <SlidersHorizontalIcon className="size-3.5" />
            管理项目
          </Button>
        </div>
      ) : null}

      <CreateProjectDialog
        connections={connections}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(projectId, summary) => {
          onSelect(projectId);
          onNotice(summary);
        }}
      />
      <ProjectVisibilityDialog
        projects={allProjects}
        hiddenProjectIds={hiddenProjectIds}
        onToggle={onToggleHiddenProject}
        onDelete={onDeleteProject}
        onUpdate={onUpdateProject}
        open={manageOpen}
        onOpenChange={setManageOpen}
      />
    </div>
  );
}

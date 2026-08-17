"use client";

import { useState } from "react";
import {
  FolderIcon,
  LayersIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { CreateProjectDialog } from "@/components/create-project-dialog";
import { ProjectVisibilityDialog } from "@/components/project-visibility-dialog";
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
  /** null 表示选中「全部」。 */
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  /** 「全部」Tab 上展示的 Thread 数（不含隐藏项目）。 */
  totalSessionCount: number;
  /** 创建项目对话框用的连接清单（按设备分组）。 */
  connections: PublicConnection[];
  canManage: boolean;
  onNotice: (message: string) => void;
};

function ProjectTab({
  selected,
  onSelect,
  label,
  count,
  title,
  icon,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  count: number;
  title?: string;
  icon: React.ReactNode;
}) {
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
      <Badge variant="outline" className="tabular-nums">
        {count}
      </Badge>
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
  selectedProjectId,
  onSelect,
  totalSessionCount,
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
          count={totalSessionCount}
          title="显示所有项目的 Bridge 与 Thread"
          icon={<LayersIcon className="size-3.5 shrink-0" />}
        />
        {projects.map((project) => (
          <ProjectTab
            key={project.id}
            selected={selectedProjectId === project.id}
            onSelect={() => onSelect(project.id)}
            label={project.name}
            count={project.sessionCount}
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
        open={manageOpen}
        onOpenChange={setManageOpen}
      />
    </div>
  );
}

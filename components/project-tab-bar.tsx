"use client";

import { FolderIcon, LayersIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/utils";
import type { SessionProjectGroup } from "@/lib/domain/session-directory-groups";

type ProjectTabBarProps = {
  projects: SessionProjectGroup[];
  /** null 表示选中「全部」。 */
  selectedProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  /** 「全部」Tab 上展示的 Thread 总数。 */
  totalSessionCount: number;
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
 * 同一个 working directory 跨 Bridge 合并为一个 Tab，「全部」表示不过滤。
 */
export function ProjectTabBar({
  projects,
  selectedProjectId,
  onSelect,
  totalSessionCount,
}: ProjectTabBarProps) {
  return (
    <div
      role="tablist"
      aria-label="按项目过滤"
      className="flex shrink-0 gap-1.5 overflow-x-auto pb-0.5"
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
  );
}

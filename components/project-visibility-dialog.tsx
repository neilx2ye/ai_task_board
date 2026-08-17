"use client";

import { EyeIcon, EyeOffIcon, FolderIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SessionProjectGroup } from "@/lib/domain/session-directory-groups";

/** 项目可见性管理：隐藏的项目从 Tab 链和「全部」视图剔除，可随时恢复。 */
export function ProjectVisibilityDialog({
  projects,
  hiddenProjectIds,
  onToggle,
  open,
  onOpenChange,
}: {
  projects: SessionProjectGroup[];
  hiddenProjectIds: ReadonlySet<string>;
  onToggle: (projectId: string, hidden: boolean) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>管理项目展示</DialogTitle>
          <DialogDescription>
            隐藏的项目不会出现在 Tab 链和「全部」视图中；仅影响当前浏览器，可随时恢复。
          </DialogDescription>
        </DialogHeader>

        {projects.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            还没有任何项目。
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
            {projects.map((project) => {
              const hidden = hiddenProjectIds.has(project.id);
              return (
                <li
                  key={project.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                >
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {project.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.workingDirectory ?? "无工作目录信息"}
                    </span>
                  </span>
                  <Badge variant="outline" className="shrink-0 tabular-nums">
                    {project.sessionCount}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 gap-1"
                    aria-pressed={hidden}
                    aria-label={`${hidden ? "恢复展示" : "隐藏"}项目「${project.name}」`}
                    onClick={() => onToggle(project.id, !hidden)}
                  >
                    {hidden ? (
                      <>
                        <EyeOffIcon className="size-3.5" />
                        已隐藏
                      </>
                    ) : (
                      <>
                        <EyeIcon className="size-3.5" />
                        展示中
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

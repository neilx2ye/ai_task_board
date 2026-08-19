"use client";

import { useState, type FormEvent } from "react";
import {
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SessionProjectGroup } from "@/lib/domain/session-directory-groups";

export type ProjectEditInput = {
  name: string;
  workingDirectory: string;
};

/**
 * 项目管理：隐藏的项目从 Tab 链和「全部」视图剔除（可随时恢复），
 * 也可以就地修改项目名称与绝对路径（路径跨 Bridge 同步，key 保持稳定）。
 * 「删除」只移除本弹窗与 Tab 链中的展示，不影响 Bridge 上的真实项目。
 */
export function ProjectVisibilityDialog({
  projects,
  hiddenProjectIds,
  removedProjectIds,
  onToggle,
  onToggleRemoved,
  onUpdate,
  open,
  onOpenChange,
}: {
  projects: SessionProjectGroup[];
  hiddenProjectIds: ReadonlySet<string>;
  removedProjectIds: ReadonlySet<string>;
  onToggle: (projectId: string, hidden: boolean) => void;
  onToggleRemoved: (projectId: string, removed: boolean) => void;
  onUpdate: (
    project: SessionProjectGroup,
    input: ProjectEditInput,
  ) => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const startEditing = (project: SessionProjectGroup) => {
    setEditingId(project.id);
    setName(project.name);
    setWorkingDirectory(project.workingDirectory ?? "");
    setError(null);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setError(null);
  };

  const save = async (
    project: SessionProjectGroup,
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const nextName = name.trim();
    const nextPath = workingDirectory.trim();
    if (!nextName) {
      setError("请输入项目名称");
      return;
    }
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(nextPath)) {
      setError("项目路径必须是绝对路径");
      return;
    }
    if (nextName === project.name && nextPath === project.workingDirectory) {
      cancelEditing();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onUpdate(project, {
        name: nextName,
        workingDirectory: nextPath,
      });
      cancelEditing();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const manageableProjects = projects.filter(
    (project) => !removedProjectIds.has(project.id),
  );
  const removedProjects = projects.filter((project) =>
    removedProjectIds.has(project.id),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancelEditing();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>管理项目</DialogTitle>
          <DialogDescription>
            可隐藏/恢复或删除项目（仅影响当前浏览器），也可编辑项目名称与
            绝对路径；修改会同步到拥有该路径的所有 Bridge，Bridge 应用后生效。
          </DialogDescription>
        </DialogHeader>

        {projects.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            还没有任何项目。
          </p>
        ) : (
          <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
            {manageableProjects.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {manageableProjects.map((project, index) => {
                  const hidden = hiddenProjectIds.has(project.id);
                  const editing = editingId === project.id;
                  const editable = project.workingDirectory !== null;
                  return (
                    <li
                      key={project.id}
                      className="rounded-md border border-border px-3 py-2"
                    >
                      {editing ? (
                        <form
                          onSubmit={(event) => save(project, event)}
                          className="flex flex-col gap-2"
                        >
                          <div className="flex items-center gap-2">
                            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm font-medium">
                              编辑项目
                            </span>
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`edit-project-name-${index}`}>
                              项目名称
                            </Label>
                            <Input
                              id={`edit-project-name-${index}`}
                              value={name}
                              maxLength={200}
                              autoFocus
                              onChange={(event) =>
                                setName(event.target.value)
                              }
                            />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`edit-project-path-${index}`}>
                              项目路径（绝对路径）
                            </Label>
                            <Input
                              id={`edit-project-path-${index}`}
                              value={workingDirectory}
                              maxLength={4096}
                              spellCheck={false}
                              className="font-mono text-xs"
                              onChange={(event) =>
                                setWorkingDirectory(event.target.value)
                              }
                            />
                          </div>
                          {error ? (
                            <p
                              role="alert"
                              className="text-xs text-destructive"
                            >
                              {error}
                            </p>
                          ) : null}
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={cancelEditing}
                            >
                              取消
                            </Button>
                            <Button
                              type="submit"
                              size="sm"
                              disabled={saving}
                            >
                              {saving ? "保存中…" : "保存"}
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex items-center gap-2">
                          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {project.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {project.workingDirectory ?? "无工作目录信息"}
                            </span>
                          </span>
                          <Badge
                            variant="outline"
                            className="shrink-0 tabular-nums"
                          >
                            {project.sessionCount}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0 gap-1"
                            disabled={!editable}
                            title={
                              editable
                                ? undefined
                                : "该项目没有路径信息，无法编辑"
                            }
                            aria-label={`编辑项目「${project.name}」`}
                            onClick={() => startEditing(project)}
                          >
                            <PencilIcon className="size-3.5" />
                            编辑
                          </Button>
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
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0 gap-1 text-muted-foreground hover:text-destructive"
                            title="只移除展示，不会改动 Bridge 上的真实项目"
                            aria-label={`删除项目「${project.name}」`}
                            onClick={() => onToggleRemoved(project.id, true)}
                          >
                            <Trash2Icon className="size-3.5" />
                            删除
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {removedProjects.length > 0 ? (
              <section
                aria-label="已删除的项目"
                className="flex flex-col gap-1.5"
              >
                <p className="px-1 text-xs text-muted-foreground">
                  已删除的项目（只移除了展示，可随时恢复）
                </p>
                <ul className="flex flex-col gap-1.5">
                  {removedProjects.map((project) => (
                    <li
                      key={project.id}
                      className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 opacity-70"
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0 gap-1"
                        aria-label={`恢复项目「${project.name}」`}
                        onClick={() => onToggleRemoved(project.id, false)}
                      >
                        <RotateCcwIcon className="size-3.5" />
                        恢复
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

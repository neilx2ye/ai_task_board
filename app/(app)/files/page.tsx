"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  FolderTreeIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react";

import { FilePreview } from "@/components/file-explorer/file-preview";
import { FileTree } from "@/components/file-explorer/file-tree";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/hooks/api-client";
import { useFileExplorerProjects } from "@/hooks/use-file-explorer";
import type {
  FileExplorerDirectory,
  FileExplorerProject,
} from "@/lib/types/domain";

function ProjectSuggestionList({
  title,
  projects,
  onOpen,
}: {
  title: string;
  projects: FileExplorerProject[];
  onOpen: (path: string) => void;
}) {
  if (projects.length === 0) return null;
  return (
    <section>
      <h3 className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {projects.map((project) => (
          <li key={project.path}>
            <button
              type="button"
              onClick={() => onOpen(project.path)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              title={project.path}
            >
              <FolderTreeIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="max-w-[40%] truncate text-xs text-muted-foreground">
                {project.path}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProjectPicker({
  onOpen,
}: {
  onOpen: (path: string) => void;
}) {
  const projects = useFileExplorerProjects();
  const [pathInput, setPathInput] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = pathInput.trim();
    if (!target) {
      setPathError("请输入项目路径");
      return;
    }
    void openPath(target);
  };

  const openPath = async (rawPath: string) => {
    setOpening(rawPath);
    setPathError(null);
    try {
      await apiFetch<FileExplorerDirectory>(
        `/api/user/file-explorer/directory?${new URLSearchParams({ path: rawPath }).toString()}`,
      );
      onOpen(rawPath);
    } catch (error) {
      setPathError(
        error instanceof ApiError
          ? error.message
          : "无法打开该路径，请确认它是有效的目录",
      );
    } finally {
      setOpening(null);
    }
  };

  const suggestions = projects.data?.projects ?? [];
  const rootSuggestions = (projects.data?.roots ?? []).map((root) => ({
    name: root,
    path: root,
  }));

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto">
      <form onSubmit={submit} className="flex flex-col gap-2 p-3">
        <div className="flex gap-2">
          <Input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="输入绝对路径，如 /home/ubuntu/project"
            aria-label="项目路径"
            list="file-explorer-path-suggestions"
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            type="submit"
            size="sm"
            disabled={opening !== null}
            className="shrink-0"
          >
            {opening !== null ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SearchIcon />
            )}
            打开
          </Button>
        </div>
        <datalist id="file-explorer-path-suggestions">
          {[...rootSuggestions, ...suggestions].map((suggestion) => (
            <option key={suggestion.path} value={suggestion.path}>
              {suggestion.name}
            </option>
          ))}
        </datalist>
        {pathError ? (
          <p role="alert" className="text-xs text-destructive">
            {pathError}
          </p>
        ) : null}
      </form>

      {projects.isLoading ? (
        <div className="px-3">
          <LoadingBlock label="加载候选项目…" />
        </div>
      ) : projects.error ? (
        <div className="px-3">
          <ErrorState
            message={projects.error.message}
            onRetry={() => void projects.refetch()}
          />
        </div>
      ) : (
        <div className="pb-3">
          <ProjectSuggestionList
            title="可浏览的根目录"
            projects={rootSuggestions}
            onOpen={(path) => void openPath(path)}
          />
          <ProjectSuggestionList
            title="项目目录"
            projects={suggestions}
            onOpen={(path) => void openPath(path)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 文件浏览与预览工作台：左侧是项目路径选择与文件树，右侧按文件类型
 * 预览 Markdown、图片与文本内容。
 */
export default function FilesPage() {
  const queryClient = useQueryClient();
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const openRoot = (path: string) => {
    setRootPath(path);
    setSelectedFile(null);
  };

  const refreshTree = () => {
    void queryClient.invalidateQueries({ queryKey: ["file-explorer"] });
  };

  return (
    <div className="flex flex-col gap-5 lg:h-[calc(100dvh-3rem)]">
      <div className="grid min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:grid-cols-[22rem_minmax(0,1fr)]">
        <aside
          aria-label="文件浏览侧边栏"
          className="flex max-h-[45dvh] min-h-0 flex-col border-b border-border lg:max-h-none lg:border-r lg:border-b-0"
        >
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">
                {rootPath ? "文件浏览" : "选择项目路径"}
              </h2>
              <p className="truncate text-xs text-muted-foreground">
                {rootPath
                  ? "点击左侧文件，在右侧预览内容"
                  : "选择要浏览文件的项目目录"}
              </p>
            </div>
            {rootPath ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  setRootPath(null);
                  setSelectedFile(null);
                }}
              >
                <ArrowLeftIcon />
                更换路径
              </Button>
            ) : null}
          </header>

          {rootPath ? (
            <FileTree
              key={rootPath}
              rootPath={rootPath}
              selectedPath={selectedFile}
              onSelectFile={setSelectedFile}
              onRefresh={refreshTree}
            />
          ) : (
            <ProjectPicker onOpen={openRoot} />
          )}
        </aside>

        <div className="min-h-[45dvh] min-w-0 lg:min-h-0">
          {rootPath ? (
            <FilePreview path={selectedFile} />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={<FolderTreeIcon className="size-6" />}
                title="还没有选择项目路径"
                description="在左侧选择一个项目目录或输入绝对路径，即可浏览其下的文件并预览 Markdown、图片与文本内容。"
                className="w-full max-w-md"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

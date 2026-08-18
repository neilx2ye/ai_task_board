"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn, formatBytes } from "@/components/utils";
import {
  useDeviceFileExplorerDirectory,
  useFileExplorerDirectory,
} from "@/hooks/use-file-explorer";
import { compareBridgeVersions } from "@/lib/bridge-version";
import {
  isImageExtension,
  isMarkdownFile,
  isTextFile,
} from "@/lib/file-kinds";
import type {
  FileExplorerBridgeProject,
  FileExplorerEntry,
  FileSource,
} from "@/lib/types/domain";

const DEVICE_FILE_BROWSING_MIN_VERSION = "1.5.0";

function iconForEntry(entry: FileExplorerEntry): ReactNode {
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  if (isImageExtension(extension)) {
    return <ImageIcon className={iconClassName} />;
  }
  if (isMarkdownFile(entry.name) || isTextFile(entry.name)) {
    return <FileTextIcon className={iconClassName} />;
  }
  return <FileIcon className={iconClassName} />;
}

type DirectoryNodeProps = {
  entry: FileExplorerEntry;
  depth: number;
  source: FileSource;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
  trailing?: ReactNode;
};

function DirectoryNode({
  entry,
  depth,
  source,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelectFile,
  trailing,
}: DirectoryNodeProps) {
  const isExpanded = expandedPaths.has(entry.path);
  const localListing = useFileExplorerDirectory(
    entry.path,
    source.kind === "local" && isExpanded,
  );
  const deviceListing = useDeviceFileExplorerDirectory(
    source.kind === "device" ? source.connectionId : null,
    entry.path,
    source.kind === "device" && isExpanded,
  );
  const listing = source.kind === "device" ? deviceListing : localListing;

  let children: ReactNode = null;
  if (isExpanded && listing.isLoading) {
    children = (
      <div
        role="status"
        style={{ paddingLeft: `${(depth + 1) * 14 + 20}px` }}
        className="flex items-center gap-2 py-1.5 text-xs text-muted-foreground"
      >
        <Loader2Icon className="size-3.5 animate-spin" />
        加载目录…
      </div>
    );
  } else if (isExpanded && listing.error) {
    children = (
      <div
        style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
        className="flex items-center gap-2 px-2 py-1.5 text-xs text-destructive"
      >
        <span className="min-w-0 flex-1 truncate">
          {listing.error.message}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          onClick={() => void listing.refetch()}
        >
          <RefreshCwIcon className="size-3.5" />
          重试
        </Button>
      </div>
    );
  } else if (isExpanded && listing.data) {
    children = (
      <ul role="group">
        {listing.data.entries.map((child) =>
          child.type === "directory" ? (
            <DirectoryNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              source={source}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
            />
          ) : (
            <FileNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selected={selectedPath === child.path}
              onSelect={() => onSelectFile(child.path)}
            />
          ),
        )}
        {listing.data.truncated ? (
          <li
            style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
            className="px-2 py-1.5 text-xs text-muted-foreground"
          >
            目录条目过多，仅显示前 1000 项
          </li>
        ) : null}
      </ul>
    );
  }

  return (
    <li
      role="treeitem"
      aria-expanded={isExpanded}
      aria-selected={selectedPath === entry.path ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => onToggle(entry.path)}
        title={entry.path}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 pr-2 text-left text-sm text-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
        />
        {isExpanded ? (
          <FolderOpenIcon className="size-4 shrink-0 text-primary" />
        ) : (
          <FolderIcon className="size-4 shrink-0 text-primary" />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {trailing}
      </button>
      {children}
    </li>
  );
}

function FileNode({
  entry,
  depth,
  selected,
  onSelect,
}: {
  entry: FileExplorerEntry;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li role="treeitem" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        title={entry.path}
        style={{ paddingLeft: `${depth * 14 + 20}px` }}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 pr-2 text-left text-sm transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          selected ? "bg-secondary text-foreground" : "text-foreground",
        )}
      >
        {iconForEntry(entry)}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.size !== null ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatBytes(entry.size)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function FileTree({
  rootPath,
  selectedPath,
  onSelectFile,
  onRefresh,
}: {
  rootPath: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set([rootPath]),
  );

  const rootEntry: FileExplorerEntry = {
    name: rootPath === "/" ? "/" : rootPath.split("/").filter(Boolean).pop() ?? rootPath,
    path: rootPath,
    type: "directory",
    size: null,
    modifiedAt: null,
  };
  const source: FileSource = { kind: "local" };

  const toggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={rootPath}
        >
          {rootPath}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="刷新文件列表"
          title="刷新文件列表"
          onClick={onRefresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <ul role="tree" className="min-h-0 flex-1 overflow-y-auto p-1">
        <DirectoryNode
          entry={rootEntry}
          depth={0}
          source={source}
          expandedPaths={expandedPaths}
          selectedPath={selectedPath}
          onToggle={toggle}
          onSelectFile={onSelectFile}
        />
      </ul>
    </div>
  );
}

/**
 * 多根目录文件树：每个可浏览根目录都是顶层层级，展开后同时展示
 * 目录与文件，文件可直接选中预览。
 */
export function FileRootsTree({
  roots,
  selectedPath,
  onSelectFile,
  onRefresh,
}: {
  roots: string[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(roots),
  );

  const toggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {roots.length > 0 ? `${roots.length} 个根目录` : "没有可浏览的根目录"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="刷新文件列表"
          title="刷新文件列表"
          onClick={onRefresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <ul role="tree" className="min-h-0 flex-1 overflow-y-auto p-1">
        {roots.map((root) => (
          <DirectoryNode
            key={root}
            entry={{
              name: root === "/" ? "/" : root,
              path: root,
              type: "directory",
              size: null,
              modifiedAt: null,
            }}
            depth={0}
            source={{ kind: "local" }}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={toggle}
            onSelectFile={onSelectFile}
          />
        ))}
      </ul>
    </div>
  );
}

function projectSource(
  project: FileExplorerBridgeProject,
): { source: FileSource; capableConnection: boolean } {
  if (project.serverAccessible) {
    return { source: { kind: "local" }, capableConnection: true };
  }
  const connection = project.connections.find((candidate) => {
    const comparison = compareBridgeVersions(
      candidate.bridgeVersion,
      DEVICE_FILE_BROWSING_MIN_VERSION,
    );
    return comparison !== null && comparison >= 0;
  });
  return connection
    ? { source: { kind: "device", connectionId: connection.id }, capableConnection: true }
    : { source: { kind: "local" }, capableConnection: false };
}

/**
 * 项目文件树：与页面顶部项目 Tab 同源，每个 Bridge 工作目录都是一个顶层
 * 项目节点；本机可读的直接列目录，远端设备走设备 Bridge 文件命令。
 */
export function ProjectFileTrees({
  projects,
  selectedPath,
  onSelectFile,
  onRefresh,
}: {
  projects: FileExplorerBridgeProject[];
  selectedPath: string | null;
  onSelectFile: (path: string, source: FileSource) => void;
  onRefresh: () => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );

  const toggle = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (projects.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <p className="text-xs text-muted-foreground">
          暂无项目目录，请先在 Bridge 上配置工作目录
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {projects.length} 个项目
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="刷新文件列表"
          title="刷新文件列表"
          onClick={onRefresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      <ul role="tree" className="min-h-0 flex-1 overflow-y-auto p-1">
        {projects.map((project) => {
          const { source, capableConnection } = projectSource(project);
          const platform =
            source.kind === "device"
              ? (project.connections.find(
                  (candidate) => candidate.id === source.connectionId,
                )?.platform ?? null)
              : null;
          const entry: FileExplorerEntry = {
            name: project.name,
            path: project.workingDirectory,
            type: "directory",
            size: null,
            modifiedAt: null,
          };
          if (!capableConnection) {
            return (
              <li
                key={project.id}
                role="treeitem"
                aria-selected="false"
                title={project.workingDirectory}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
              >
                <FolderIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  需升级 Bridge 1.5.0
                </span>
              </li>
            );
          }
          return (
            <DirectoryNode
              key={project.id}
              entry={entry}
              depth={0}
              source={source}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              onToggle={toggle}
              onSelectFile={(path) => onSelectFile(path, source)}
              trailing={
                <span className="shrink-0 text-xs text-muted-foreground">
                  {project.serverAccessible ? "本机" : (platform ?? "设备")}
                </span>
              }
            />
          );
        })}
      </ul>
    </div>
  );
}

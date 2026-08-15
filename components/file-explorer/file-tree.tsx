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
import { useFileExplorerDirectory } from "@/hooks/use-file-explorer";
import {
  isImageExtension,
  isMarkdownFile,
  isTextFile,
} from "@/lib/file-kinds";
import type { FileExplorerEntry } from "@/lib/types/domain";

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
  expandedPaths: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
};

function DirectoryNode({
  entry,
  depth,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelectFile,
}: DirectoryNodeProps) {
  const isExpanded = expandedPaths.has(entry.path);
  const listing = useFileExplorerDirectory(entry.path, isExpanded);

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
          expandedPaths={expandedPaths}
          selectedPath={selectedPath}
          onToggle={toggle}
          onSelectFile={onSelectFile}
        />
      </ul>
    </div>
  );
}

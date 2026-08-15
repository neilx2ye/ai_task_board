"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import type {
  FileExplorerDirectory,
  FileExplorerProjects,
  FilePreview,
} from "@/lib/types/domain";

const FILE_EXPLORER_PROJECTS_KEY = ["file-explorer", "projects"] as const;

const fileExplorerDirectoryKey = (path: string) =>
  ["file-explorer", "directory", path] as const;

const fileExplorerFileKey = (path: string) =>
  ["file-explorer", "file", path] as const;

function queryPath(path: string): string {
  return `?${new URLSearchParams({ path }).toString()}`;
}

/** 可浏览根目录与候选项目路径。 */
export function useFileExplorerProjects(enabled = true) {
  return useQuery({
    queryKey: FILE_EXPLORER_PROJECTS_KEY,
    enabled,
    queryFn: async () =>
      apiFetch<FileExplorerProjects>("/api/user/file-explorer/projects"),
    staleTime: 60_000,
  });
}

/** 指定目录的条目列表；启用后按路径缓存，切换目录时逐级惰性加载。 */
export function useFileExplorerDirectory(
  path: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: fileExplorerDirectoryKey(path ?? ""),
    enabled: Boolean(path) && enabled,
    queryFn: async () =>
      apiFetch<FileExplorerDirectory>(
        `/api/user/file-explorer/directory${queryPath(path ?? "")}`,
      ),
    staleTime: 30_000,
  });
}

/** 单文件预览内容。 */
export function useFileExplorerFile(path: string | null) {
  return useQuery({
    queryKey: fileExplorerFileKey(path ?? ""),
    enabled: Boolean(path),
    queryFn: async () =>
      apiFetch<FilePreview>(
        `/api/user/file-explorer/file${queryPath(path ?? "")}`,
      ),
    staleTime: 30_000,
  });
}

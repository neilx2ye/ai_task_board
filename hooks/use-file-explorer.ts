"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import type {
  FileDeviceCommand,
  FileExplorerDirectory,
  FileExplorerProjects,
  FilePreview,
} from "@/lib/types/domain";

const FILE_EXPLORER_PROJECTS_KEY = ["file-explorer", "projects"] as const;
const DEVICE_COMMAND_POLL_INTERVAL_MS = 1_500;
const DEVICE_COMMAND_TIMEOUT_MS = 90_000;

const fileExplorerDirectoryKey = (path: string) =>
  ["file-explorer", "directory", path] as const;

const fileExplorerFileKey = (path: string) =>
  ["file-explorer", "file", path] as const;

const fileDeviceDirectoryKey = (connectionId: string, path: string) =>
  ["file-explorer", "device-directory", connectionId, path] as const;

const fileDeviceFileKey = (connectionId: string, path: string) =>
  ["file-explorer", "device-file", connectionId, path] as const;

function queryPath(path: string): string {
  return `?${new URLSearchParams({ path }).toString()}`;
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 创建一条设备文件命令并轮询到终态；结果直接复用本地目录/预览的类型。 */
async function runDeviceFileCommand(
  input: { connectionId: string; action: "list" | "read"; path: string },
  signal?: AbortSignal,
): Promise<FileDeviceCommand> {
  const created = await apiFetch<FileDeviceCommand>(
    "/api/user/file-explorer/device-commands",
    {
      method: "POST",
      json: {
        connection_id: input.connectionId,
        action: input.action,
        path: input.path,
      },
      signal,
    },
  );
  const deadline = Date.now() + DEVICE_COMMAND_TIMEOUT_MS;
  let current = created;
  while (current.status === "queued" || current.status === "running") {
    if (Date.now() >= deadline) {
      throw new Error("设备 Bridge 未在限期内返回文件结果，请确认设备在线");
    }
    await abortableDelay(DEVICE_COMMAND_POLL_INTERVAL_MS, signal);
    current = await apiFetch<FileDeviceCommand>(
      `/api/user/file-explorer/device-commands/${created.id}`,
      { signal },
    );
  }
  if (current.status === "failed") {
    throw new Error(current.error ?? "设备文件读取失败");
  }
  return current;
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

/** 设备 Bridge 上的目录列表；启用后创建命令并轮询，结果缓存 30 秒。 */
export function useDeviceFileExplorerDirectory(
  connectionId: string | null,
  path: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: fileDeviceDirectoryKey(connectionId ?? "", path ?? ""),
    enabled: Boolean(connectionId) && Boolean(path) && enabled,
    queryFn: async ({ signal }) => {
      const command = await runDeviceFileCommand(
        {
          connectionId: connectionId as string,
          action: "list",
          path: path as string,
        },
        signal,
      );
      if (!command.result || !("entries" in command.result)) {
        throw new Error("设备返回了无效的目录列表");
      }
      return command.result;
    },
    staleTime: 30_000,
  });
}

/** 设备 Bridge 上的单文件预览；结果缓存 30 秒。 */
export function useDeviceFileExplorerFile(
  connectionId: string | null,
  path: string | null,
) {
  return useQuery({
    queryKey: fileDeviceFileKey(connectionId ?? "", path ?? ""),
    enabled: Boolean(connectionId) && Boolean(path),
    queryFn: async ({ signal }) => {
      const command = await runDeviceFileCommand(
        {
          connectionId: connectionId as string,
          action: "read",
          path: path as string,
        },
        signal,
      );
      if (!command.result || !("kind" in command.result)) {
        throw new Error("设备返回了无效的文件预览");
      }
      return command.result;
    },
    staleTime: 30_000,
  });
}

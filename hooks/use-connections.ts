"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import { SESSIONS_QUERY_KEY } from "@/hooks/query-keys";
import {
  isAntigravityPlatform,
  isKimiPlatform,
} from "@/lib/agent-platforms";
import type { AgentModelCatalogEntry } from "@/lib/codex-models";
import type { AIConnectionRow, Json } from "@/lib/types/database";

/** 连接行中不含令牌哈希的服务端投影。 */
export type PublicConnection = Omit<AIConnectionRow, "api_token_hash"> & {
  model_catalog?: AgentModelCatalogEntry[] | null;
  model_catalog_updated_at?: string | null;
  quota?: Json | null;
  quota_updated_at?: string | null;
  /** Bridge 自上报的稳定设备标识；旧 Bridge 未上报时为 null。 */
  device_id?: string | null;
  device_label?: string | null;
  /** Owner 设置的自更新目标版本；null 表示无待升级。 */
  desired_bridge_version?: string | null;
};

export type ConnectionWithToken = {
  connection: PublicConnection;
  /** 明文令牌仅在创建 / 轮换时返回一次。 */
  token: string;
};

export type ConnectionInput = {
  name: string;
  platform: string;
};

export const CONNECTIONS_KEY = ["connections"] as const;

/** 防御性过滤：列表只保留未被撤销的连接（revoked_at 为 null）。 */
export function activeConnections(
  connections: PublicConnection[],
): PublicConnection[] {
  return connections.filter((connection) => connection.revoked_at === null);
}

function supportsBridgeMinorVersion(
  connection: Pick<AIConnectionRow, "bridge_version">,
  minimumMinor: number,
): boolean {
  const match = connection.bridge_version?.match(/^(\d+)\.(\d+)(?:\.|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= minimumMinor;
}

export function supportsWebThreadManagement(
  connection: Pick<AIConnectionRow, "bridge_version">,
): boolean {
  return supportsBridgeMinorVersion(connection, 5);
}

export function supportsWebThreadRename(
  connection: Pick<AIConnectionRow, "bridge_version" | "platform">,
): boolean {
  return (
    supportsWebThreadManagement(connection) &&
    !isKimiPlatform(connection.platform) &&
    !isAntigravityPlatform(connection.platform)
  );
}

export function supportsWorkingDirectoryInventory(
  connection: Pick<AIConnectionRow, "bridge_version">,
): boolean {
  return supportsBridgeMinorVersion(connection, 7);
}

/**
 * 设备端创建项目目录（create_if_missing）与设备标识上报从 Bridge 1.3.0 开始；
 * 同时 Kimi / Antigravity 运行时的 Web 目录管理也在该版本加入。
 */
export function supportsManagedDirectoryCreation(
  connection: Pick<AIConnectionRow, "bridge_version">,
): boolean {
  const match = connection.bridge_version?.match(/^(\d+)\.(\d+)(?:\.|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 3);
}

/**
 * Web 触发的 Bridge 自更新从 1.4.0 开始携带更新器；
 * 更早的版本只能在设备上手动升级一次。
 */
export function supportsRemoteBridgeUpdate(
  connection: Pick<AIConnectionRow, "bridge_version">,
): boolean {
  const match = connection.bridge_version?.match(/^(\d+)\.(\d+)(?:\.|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 4);
}

export function useConnections(enabled = true) {
  return useQuery({
    queryKey: CONNECTIONS_KEY,
    enabled,
    queryFn: async () => {
      const data = await apiFetch<{ connections?: PublicConnection[] }>(
        "/api/user/connections",
      );
      return activeConnections(data.connections ?? []);
    },
  });
}

function useConnectionMutation<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}

export function useCreateConnection() {
  return useConnectionMutation((input: ConnectionInput) =>
    apiFetch<ConnectionWithToken>("/api/user/connections", {
      method: "POST",
      json: input,
    }),
  );
}

export function useRenameConnection(connectionId: string) {
  return useConnectionMutation((input: { name: string }) =>
    apiFetch<{ connection: PublicConnection }>(
      `/api/user/connections/${connectionId}`,
      { method: "PATCH", json: input },
    ),
  );
}

export function useRotateConnection(connectionId: string) {
  return useConnectionMutation(() =>
    apiFetch<ConnectionWithToken>(
      `/api/user/connections/${connectionId}/rotate`,
      { method: "POST", json: {} },
    ),
  );
}

export function useRevokeConnection(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<unknown>(`/api/user/connections/${connectionId}/revoke`, {
        method: "POST",
        json: {},
      }),
    onSuccess: () => {
      // 立即把被撤销的连接移出缓存，再 invalidate 与服务端对齐。
      queryClient.setQueryData<PublicConnection[]>(CONNECTIONS_KEY, (old) =>
        old?.filter((connection) => connection.id !== connectionId),
      );
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}

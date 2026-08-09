"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import type { AIConnectionRow } from "@/lib/types/database";

/** 连接行中不含令牌哈希的服务端投影。 */
export type PublicConnection = Omit<AIConnectionRow, "api_token_hash">;

export type ConnectionWithToken = {
  connection: PublicConnection;
  /** 明文令牌仅在创建 / 轮换时返回一次。 */
  token: string;
};

export type ConnectionInput = {
  name: string;
  platform: string;
};

const CONNECTIONS_KEY = ["connections"] as const;

/** 防御性过滤：列表只保留未被撤销的连接（revoked_at 为 null）。 */
export function activeConnections(
  connections: PublicConnection[],
): PublicConnection[] {
  return connections.filter((connection) => connection.revoked_at === null);
}

export function useConnections() {
  return useQuery({
    queryKey: CONNECTIONS_KEY,
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
    },
  });
}

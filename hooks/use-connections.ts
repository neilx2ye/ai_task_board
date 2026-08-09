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

export function useConnections() {
  return useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: async () => {
      const data = await apiFetch<{ connections?: PublicConnection[] }>(
        "/api/user/connections",
      );
      return data.connections ?? [];
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
  return useConnectionMutation(() =>
    apiFetch<unknown>(`/api/user/connections/${connectionId}/revoke`, {
      method: "POST",
      json: {},
    }),
  );
}

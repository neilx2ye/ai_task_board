"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import { CONNECTIONS_KEY } from "@/hooks/use-connections";

const BRIDGE_RELEASE_KEY = ["bridge-release"] as const;

/** npm 上 ai-task-board-bridge 的最新发布版本（服务端查询并缓存；失败为 null）。 */
export function useBridgeRelease() {
  return useQuery({
    queryKey: BRIDGE_RELEASE_KEY,
    queryFn: () =>
      apiFetch<{ latest_version: string | null }>(
        "/api/user/bridge-release",
      ),
    staleTime: 60_000,
    retry: 1,
  });
}

export type BridgeUpdateTargetResponse = {
  desired_bridge_version: string | null;
};

export async function setBridgeUpdateTarget(
  connectionId: string,
  targetVersion: string | null,
  platform?: string | null,
): Promise<BridgeUpdateTargetResponse> {
  return apiFetch<BridgeUpdateTargetResponse>(
    `/api/user/connections/${encodeURIComponent(connectionId)}/bridge-update`,
    {
      method: "POST",
      json: {
        target_version: targetVersion,
        ...(platform ? { platform } : {}),
      },
    },
  );
}

/** 设置/取消单个 Bridge 的自更新目标版本。 */
export function useSetBridgeUpdateTarget(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      targetVersion,
      platform,
    }: {
      targetVersion: string | null;
      platform?: string | null;
    }) => setBridgeUpdateTarget(connectionId, targetVersion, platform),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
    },
  });
}

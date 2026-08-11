"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import { BRIDGE_DIRECTORIES_QUERY_KEY } from "@/hooks/query-keys";
import type { AIBridgeDirectoryRow } from "@/lib/types/database";

export function useBridgeDirectories(enabled = true) {
  return useQuery({
    queryKey: BRIDGE_DIRECTORIES_QUERY_KEY,
    enabled,
    queryFn: async () => {
      const data = await apiFetch<{
        directories?: AIBridgeDirectoryRow[];
      }>("/api/user/bridge-directories");
      return data.directories ?? [];
    },
    refetchInterval: 30_000,
  });
}

"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import type { AIBridgeDirectoryRow } from "@/lib/types/database";

const BRIDGE_DIRECTORIES_KEY = ["bridge-directories"] as const;

export function useBridgeDirectories(enabled = true) {
  return useQuery({
    queryKey: BRIDGE_DIRECTORIES_KEY,
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

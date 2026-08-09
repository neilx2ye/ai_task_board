"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import type { AISessionRow } from "@/lib/types/database";

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const data =
        await apiFetch<{ sessions?: AISessionRow[] }>("/api/user/sessions");
      return data.sessions ?? [];
    },
    // 会话是否“存活”取决于 last_seen_at；即使没有 Realtime 事件，页面也要
    // 定期重新计算并拉取心跳结果。
    refetchInterval: 30_000,
  });
}

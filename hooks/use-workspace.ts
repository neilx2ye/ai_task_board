"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import type { MemberRole, WorkspaceRow } from "@/lib/types/database";

type WorkspaceResponse = {
  workspace: WorkspaceRow | null;
  role?: MemberRole;
};

/** 当前用户的 Workspace。MVP 假定单 Workspace。 */
export function useWorkspace() {
  return useQuery({
    queryKey: ["workspace"],
    queryFn: async () => {
      const data = await apiFetch<WorkspaceResponse>("/api/user/workspace");
      return { workspace: data.workspace ?? null, role: data.role ?? null };
    },
  });
}

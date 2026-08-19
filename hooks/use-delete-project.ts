"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import {
  BRIDGE_DIRECTORIES_QUERY_KEY,
  SESSIONS_QUERY_KEY,
} from "@/hooks/query-keys";
import type {
  AIBridgeDirectoryRow,
  ProjectDeletionResponse,
} from "@/lib/types/database";
import type { SessionListItem } from "@/lib/types/domain";

export type DeleteProjectVariables = {
  working_directory: string;
};

/**
 * 删除项目：服务端删除目录清单记录并停止 Bridge 托管后，立即更新本地目录
 * 与 Session 缓存，让项目从所有浏览器的 Tab 链中消失。
 */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteProjectVariables) =>
      apiFetch<ProjectDeletionResponse>("/api/user/projects", {
        method: "DELETE",
        json: input,
      }),
    onSuccess: (_response, input) => {
      queryClient.setQueryData<AIBridgeDirectoryRow[]>(
        BRIDGE_DIRECTORIES_QUERY_KEY,
        (current) =>
          current?.filter(
            (directory) =>
              directory.working_directory !== input.working_directory,
          ),
      );
      queryClient.setQueryData<SessionListItem[]>(
        SESSIONS_QUERY_KEY,
        (current) =>
          current?.map((session) =>
            session.working_directory === input.working_directory
              ? {
                  ...session,
                  bridge_directory_key: null,
                  inventory_active: false,
                  status: "offline",
                }
              : session,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: BRIDGE_DIRECTORIES_QUERY_KEY,
      });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["planning-notes"] });
    },
  });
}

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import {
  BRIDGE_DIRECTORIES_QUERY_KEY,
  SESSIONS_QUERY_KEY,
} from "@/hooks/query-keys";
import type {
  AIBridgeDirectoryRow,
  CreateProjectResponse,
} from "@/lib/types/database";

export type UpdateProjectVariables = {
  /** 现有项目路径，用于定位目录清单里的条目。 */
  working_directory: string;
  name: string;
  new_working_directory: string;
};

/**
 * 修改项目名称与路径：PATCH 下发到各 Bridge，并在设备同步前先在本地
 * 更新目录清单缓存，让 Tab 链立即反映新名称与新路径。
 */
export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectVariables) =>
      apiFetch<CreateProjectResponse>("/api/user/projects", {
        method: "PATCH",
        json: input,
      }),
    onSuccess: (response, input) => {
      if (!response.results.some((result) => result.status === "submitted")) {
        return;
      }
      queryClient.setQueryData<AIBridgeDirectoryRow[]>(
        BRIDGE_DIRECTORIES_QUERY_KEY,
        (current) =>
          current?.map((directory) =>
            directory.working_directory === input.working_directory
              ? {
                  ...directory,
                  name: input.name,
                  working_directory: input.new_working_directory,
                }
              : directory,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: BRIDGE_DIRECTORIES_QUERY_KEY,
      });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      if (input.new_working_directory !== input.working_directory) {
        // 路径变化后服务端会把规划笔记迁到新 project_ref，旧缓存需要刷新。
        void queryClient.invalidateQueries({
          queryKey: ["planning-notes"],
        });
      }
    },
  });
}

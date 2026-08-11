"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { apiFetch } from "@/hooks/api-client";
import type { TaskDetails } from "@/lib/types/domain";
import type {
  ArtifactRow,
  TaskMessageRow,
  TaskRow,
} from "@/lib/types/database";

export type TaskListData = {
  tasks: TaskRow[];
  /** 每个 waiting_user 任务的最新 AI 消息（由列表接口附带，可能为空）。 */
  latestAiMessages: TaskMessageRow[];
};

export type TaskInput = {
  title: string;
  description?: string | null;
  acceptance_criteria?: string | null;
  priority?: number;
  required_capabilities?: string[];
  parent_task_id?: string | null;
  assigned_session_id?: string | null;
};

export type SubtaskInput = {
  title: string;
  description?: string | null;
  acceptance_criteria?: string | null;
  priority?: number;
  assigned_session_id: string;
  depends_on_task_ids?: string[];
};

const TASKS_KEY = ["tasks"] as const;
const taskKey = (taskId: string) => ["tasks", taskId] as const;

export function useTasks() {
  return useQuery({
    queryKey: TASKS_KEY,
    queryFn: async (): Promise<TaskListData> => {
      const data = await apiFetch<{
        tasks?: TaskRow[];
        latest_ai_messages?: TaskMessageRow[];
      }>("/api/user/tasks");
      return {
        tasks: data.tasks ?? [],
        latestAiMessages: data.latest_ai_messages ?? [],
      };
    },
  });
}

export function useTaskDetails(taskId: string | undefined) {
  return useQuery({
    queryKey: taskKey(taskId ?? ""),
    enabled: Boolean(taskId),
    queryFn: () => apiFetch<TaskDetails>(`/api/user/tasks/${taskId}`),
  });
}

function useTaskInvalidation() {
  const queryClient = useQueryClient();
  return (taskId?: string) => {
    void queryClient.invalidateQueries({ queryKey: TASKS_KEY });
    if (taskId) {
      void queryClient.invalidateQueries({ queryKey: taskKey(taskId) });
    }
  };
}

export function useCreateTask(): UseMutationResult<TaskRow, Error, TaskInput> {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input) =>
      apiFetch<TaskRow>("/api/user/tasks", { method: "POST", json: input }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateTask(taskId: string) {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: Partial<TaskInput>) =>
      apiFetch<TaskRow>(`/api/user/tasks/${taskId}`, {
        method: "PATCH",
        json: input,
      }),
    onSuccess: () => invalidate(taskId),
  });
}

export function useCreateSubtasks(taskId: string) {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: SubtaskInput) =>
      apiFetch<TaskRow>(`/api/user/tasks/${taskId}/subtasks`, {
        method: "POST",
        json: input,
      }),
    onSuccess: () => invalidate(taskId),
  });
}

function useTaskAction(taskId: string, action: string) {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (json?: unknown) =>
      apiFetch<unknown>(`/api/user/tasks/${taskId}/${action}`, {
        method: "POST",
        json: json ?? {},
      }),
    onSuccess: () => invalidate(taskId),
  });
}

/** 回复 AI 的提问，任务恢复到原会话的 ready 预留队列。 */
export function useReplyToTask(taskId: string) {
  return useTaskAction(taskId, "reply");
}

/** 在任务消息流中追加一条用户消息（不改变任务状态）。 */
export function usePostTaskMessage(taskId: string) {
  return useTaskAction(taskId, "messages");
}

export function useAnswerTaskUserInput(taskId: string, requestId: string) {
  const invalidate = useTaskInvalidation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (answers: Record<string, string[]>) =>
      apiFetch<unknown>(
        `/api/user/tasks/${taskId}/input-requests/${requestId}/answer`,
        { method: "POST", json: { answers } },
      ),
    onSuccess: () => {
      invalidate(taskId);
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}

export function useCancelTask(taskId: string) {
  return useTaskAction(taskId, "cancel");
}

export function useReopenTask(taskId: string) {
  return useTaskAction(taskId, "reopen");
}

export function useReleaseTask(taskId: string) {
  return useTaskAction(taskId, "release");
}

/**
 * 上传任务附件。服务端接口为 multipart/form-data（字段名 file，最大 50 MiB），
 * apiFetch 会自动携带 Idempotency-Key，成功后失效任务与看板查询。
 */
export function useUploadArtifact(taskId: string) {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return apiFetch<ArtifactRow>(`/api/user/tasks/${taskId}/artifacts`, {
        method: "POST",
        body: formData,
      });
    },
    onSuccess: () => invalidate(taskId),
  });
}

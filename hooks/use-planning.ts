"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { apiFetch } from "@/hooks/api-client";
import { createPendingIdempotencyTracker } from "@/hooks/pending-idempotency";
import {
  planningNotesQueryKey,
  SESSIONS_QUERY_KEY,
  TASKS_QUERY_KEY,
  turnPlansQueryKey,
} from "@/hooks/query-keys";
import type { TurnPlanStep } from "@/lib/types/domain";
import type {
  PlanningNoteRow,
  SessionTurnPlanRow,
} from "@/lib/types/database";

export function usePlanningNote(
  projectRef: string | null,
) {
  return useQuery({
    queryKey: planningNotesQueryKey(projectRef ?? ""),
    enabled: Boolean(projectRef),
    queryFn: async () => {
      const query = new URLSearchParams({
        project_ref: projectRef!,
      });
      const data = await apiFetch<{ note: PlanningNoteRow | null }>(
        `/api/user/planning-notes?${query.toString()}`,
      );
      return data.note;
    },
  });
}

export function useSavePlanningNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { project_ref: string; content: string }) =>
      apiFetch<{ note: PlanningNoteRow }>(`/api/user/planning-notes`, {
        method: "PUT",
        json: input,
      }),
    onSuccess: (data, input) => {
      queryClient.setQueryData(
        planningNotesQueryKey(input.project_ref),
        data.note,
      );
    },
  });
}

export function useTurnPlanSteps(sessionId: string | null) {
  return useQuery({
    queryKey: turnPlansQueryKey(sessionId ?? ""),
    enabled: Boolean(sessionId),
    queryFn: async () => {
      const data = await apiFetch<{ steps?: TurnPlanStep[] }>(
        `/api/user/sessions/${sessionId}/turn-plans`,
      );
      return data.steps ?? [];
    },
  });
}

export function useCreateTurnPlanStep(sessionId: string) {
  const queryClient = useQueryClient();
  const idempotency = useRef<
    ReturnType<typeof createPendingIdempotencyTracker> | undefined
  >(undefined);
  const requestKeys = useRef(
    new WeakMap<
      { content: string; model?: string | null; reasoning_effort?: string | null },
      { fingerprint: string; key: string }
    >(),
  );
  idempotency.current ??= createPendingIdempotencyTracker();
  return useMutation({
    mutationFn: (input: {
      content: string;
      model?: string | null;
      reasoning_effort?: string | null;
    }) => {
      const fingerprint = `${sessionId}\0${input.content}\0${input.model ?? ""}\0${input.reasoning_effort ?? ""}`;
      const idempotencyKey = idempotency.current!.keyFor(fingerprint);
      requestKeys.current.set(input, { fingerprint, key: idempotencyKey });
      return apiFetch<{ step: SessionTurnPlanRow }>(
        `/api/user/sessions/${sessionId}/turn-plans`,
        { method: "POST", json: input, idempotencyKey },
      );
    },
    onSuccess: (_result, input) => {
      const request = requestKeys.current.get(input);
      if (request) {
        idempotency.current!.confirm(request.fingerprint, request.key);
      }
      void queryClient.invalidateQueries({
        queryKey: turnPlansQueryKey(sessionId),
      });
    },
    onSettled: (_result, _error, input) => {
      requestKeys.current.delete(input);
    },
  });
}

export function useUpdateTurnPlanStep(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      stepId: string;
      content?: string;
      position?: number;
      model?: string | null;
      reasoning_effort?: string | null;
    }) => {
      const { stepId, ...patch } = input;
      return apiFetch<{ step: SessionTurnPlanRow }>(
        `/api/user/turn-plans/${stepId}`,
        { method: "PATCH", json: patch },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: turnPlansQueryKey(sessionId),
      });
    },
  });
}

export function useDeleteTurnPlanStep(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stepId: string) =>
      apiFetch<{ deleted: boolean }>(`/api/user/turn-plans/${stepId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: turnPlansQueryKey(sessionId),
      });
    },
  });
}

/** 派发后任务与排队数变化，同时刷新会话与任务缓存。 */
export function useDispatchTurnPlanChain(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ dispatched: { step_id: string; task_id: string }[] }>(
        `/api/user/sessions/${sessionId}/turn-plans/dispatch`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: turnPlansQueryKey(sessionId),
      });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
  });
}

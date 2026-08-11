"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useRef } from "react";

import { apiFetch } from "@/hooks/api-client";
import { createPendingIdempotencyTracker } from "@/hooks/pending-idempotency";
import type { SessionConversation, SessionListItem } from "@/lib/types/domain";
import type { AISessionRow, AIThreadCommandRow } from "@/lib/types/database";

const SESSIONS_KEY = ["sessions"] as const;
const sessionKey = (sessionId: string) => ["sessions", sessionId] as const;

export function sessionConversationRecoveryInterval(
  pageCount: number,
  historyStatus: "syncing" | "partial" | "complete" | "failed" | null = null,
): 3_000 | 30_000 | false {
  if (historyStatus === "syncing" && pageCount <= 1) return 3_000;
  return pageCount <= 1 ? 30_000 : false;
}

export function useSessions() {
  return useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: async () => {
      const data =
        await apiFetch<{ sessions?: SessionListItem[] }>("/api/user/sessions");
      return data.sessions ?? [];
    },
    // 会话是否“存活”取决于 last_seen_at；即使没有 Realtime 事件，页面也要
    // 定期重新计算并拉取心跳结果。
    refetchInterval: 30_000,
  });
}

export function useSessionConversation(sessionId: string | null) {
  return useInfiniteQuery({
    queryKey: sessionKey(sessionId ?? ""),
    enabled: Boolean(sessionId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "100" });
      if (pageParam) query.set("before_activity_cursor", pageParam);
      return apiFetch<SessionConversation>(
        `/api/user/sessions/${sessionId}?${query.toString()}`,
      );
    },
    getNextPageParam: (lastPage) =>
      lastPage.pagination.activities.has_more_older
        ? (lastPage.pagination.activities.oldest_cursor ?? undefined)
        : undefined,
    // SessionActivity Realtime rows are merged directly into this cache. Keep
    // a recovery poll while only the newest page is loaded; polling a
    // multi-page infinite query would refetch every historical page in order.
    // Realtime reconnect catch-up remains the recovery path after pagination.
    refetchInterval: (query) =>
      sessionConversationRecoveryInterval(
        query.state.data?.pages.length ?? 0,
        query.state.data?.pages[0]?.history_sync?.status ?? null,
      ),
  });
}

function valuesById<T>(values: readonly T[], id: (value: T) => string) {
  return [...new Map(values.map((value) => [id(value), value])).values()];
}

type ActivityOrderingFields = {
  created_at: string;
  occurred_at?: string;
  source_order?: string;
  id: string;
};

export function sessionActivityOccurredAt(
  activity: ActivityOrderingFields,
): string {
  return activity.occurred_at ?? activity.created_at;
}

function compareLosslessIntegers(left: string, right: string): number {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

/** Match the API's stable chronological order without coercing bigint strings. */
export function compareSessionActivities(
  left: ActivityOrderingFields,
  right: ActivityOrderingFields,
): number {
  const byTime = sessionActivityOccurredAt(left).localeCompare(
    sessionActivityOccurredAt(right),
  );
  if (byTime) return byTime;
  const bySourceOrder = compareLosslessIntegers(
    left.source_order ?? left.id,
    right.source_order ?? right.id,
  );
  return bySourceOrder || compareLosslessIntegers(left.id, right.id);
}

/** Combine newest-first API pages into one chronological conversation. */
export function mergeSessionConversationPages(
  pages: readonly SessionConversation[] | undefined,
): SessionConversation | undefined {
  if (!pages?.length) return undefined;
  const first = pages[0];
  const last = pages.at(-1) ?? first;
  const activities = valuesById(
    pages.flatMap((page) => page.activities),
    (activity) => activity.id,
  ).sort(compareSessionActivities);
  const legacy = pages.map((page) => page.pagination.legacy);

  return {
    session: first.session,
    history_sync: first.history_sync,
    tasks: valuesById(
      pages.flatMap((page) => page.tasks),
      (task) => task.id,
    ).sort((left, right) => left.created_at.localeCompare(right.created_at)),
    messages: valuesById(
      pages.flatMap((page) => page.messages),
      (message) => message.id,
    ).sort((left, right) => left.created_at.localeCompare(right.created_at)),
    input_requests: valuesById(
      pages.flatMap((page) => page.input_requests ?? []),
      (request) => request.id,
    ).sort((left, right) => left.created_at.localeCompare(right.created_at)),
    events: valuesById(
      pages.flatMap((page) => page.events),
      (event) => String(event.id),
    ).sort((left, right) => left.id - right.id),
    activities,
    pagination: {
      activities: {
        ...last.pagination.activities,
        newest_cursor: first.pagination.activities.newest_cursor,
        oldest_cursor: last.pagination.activities.oldest_cursor,
      },
      legacy: {
        limit: Math.max(...legacy.map((value) => value.limit)),
        tasks_truncated: legacy.some((value) => value.tasks_truncated),
        messages_truncated: legacy.some((value) => value.messages_truncated),
        events_truncated: legacy.some((value) => value.events_truncated),
      },
    },
  };
}

export function useCreateSessionTurn(sessionId: string) {
  const queryClient = useQueryClient();
  const idempotency = useRef<
    ReturnType<typeof createPendingIdempotencyTracker> | undefined
  >(undefined);
  const requestKeys = useRef(
    new WeakMap<{ content: string }, { fingerprint: string; key: string }>(),
  );
  idempotency.current ??= createPendingIdempotencyTracker();
  return useMutation({
    mutationFn: (input: { content: string }) => {
      const fingerprint = `${sessionId}\0${input.content}`;
      const idempotencyKey = idempotency.current!.keyFor(fingerprint);
      requestKeys.current.set(input, { fingerprint, key: idempotencyKey });
      return apiFetch<unknown>(`/api/user/sessions/${sessionId}/turns`, {
        method: "POST",
        json: input,
        idempotencyKey,
      });
    },
    onSuccess: (_result, input) => {
      const request = requestKeys.current.get(input);
      if (request) {
        idempotency.current!.confirm(request.fingerprint, request.key);
      }
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onSettled: (_result, _error, input) => {
      requestKeys.current.delete(input);
    },
  });
}

type ThreadCommandResult = { command: AIThreadCommandRow };

export function useCreateThread(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; directory_key?: string | null }) =>
      apiFetch<ThreadCommandResult>(
        `/api/user/connections/${connectionId}/threads`,
        { method: "POST", json: input },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["bridge-directories"] });
    },
  });
}

export function useRenameThread(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) =>
      apiFetch<ThreadCommandResult>(`/api/user/sessions/${sessionId}`, {
        method: "PATCH",
        json: input,
      }),
    onSuccess: (_result, input) => {
      queryClient.setQueryData<SessionListItem[]>(SESSIONS_KEY, (current) =>
        current?.map((session) =>
          session.id === sessionId
            ? { ...session, name: input.name, user_name: input.name }
            : session,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) });
    },
  });
}

type SessionProcessDetailsSyncResult = { session: AISessionRow };

export function useUpdateSessionProcessDetailsSync(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sync_process_details: boolean }) =>
      apiFetch<SessionProcessDetailsSyncResult>(
        `/api/user/sessions/${sessionId}/process-details`,
        { method: "PATCH", json: input },
      ),
    onSuccess: ({ session }) => {
      const syncProcessDetails = session.sync_process_details;
      queryClient.setQueryData<SessionListItem[]>(SESSIONS_KEY, (current) =>
        current?.map((item) =>
          item.id === sessionId
            ? { ...item, sync_process_details: syncProcessDetails }
            : item,
        ),
      );
      queryClient.setQueryData<InfiniteData<SessionConversation>>(
        sessionKey(sessionId),
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  session: {
                    ...page.session,
                    sync_process_details: syncProcessDetails,
                  },
                })),
              }
            : current,
      );
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) });
    },
  });
}

export function useDeleteThread(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ThreadCommandResult>(`/api/user/sessions/${sessionId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.setQueryData<SessionListItem[]>(SESSIONS_KEY, (current) =>
        current?.filter((session) => session.id !== sessionId),
      );
      queryClient.removeQueries({ queryKey: sessionKey(sessionId), exact: true });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { useSelectedSessionIds } from "@/hooks/use-selected-session-ids";

const STORAGE_KEY = "ai-task-board:selected-session-ids";
const REMOTE_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_A = "22222222-2222-4222-8222-222222222222";
const LEGACY_B = "33333333-3333-4333-8333-333333333333";
const NEW_ID = "44444444-4444-4444-8444-444444444444";
const FALLBACK_ID = "55555555-5555-4555-8555-555555555555";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function row(sessionIds: string[]) {
  return {
    workspace_id: "workspace-1",
    user_id: "user-1",
    selected_session_ids: sessionIds,
    updated_at: "2026-08-19T00:00:00.000Z",
  };
}

describe("selected Session database state", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let putBodies: unknown[];

  beforeEach(() => {
    window.localStorage.clear();
    putBodies = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        putBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          threads: row(
            (JSON.parse(String(init?.body)) as { session_ids: string[] })
              .session_ids,
          ),
        });
      }
      if (method === "GET") return jsonResponse({ threads: row([REMOTE_ID]) });
      throw new Error(`Unexpected request: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      createElement(QueryClientProvider, { client: queryClient }, children)
    );
    return {
      queryClient,
      ...renderHook(() => useSelectedSessionIds(), { wrapper }),
    };
  }

  it("restores the remote selection and drops the legacy localStorage copy", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([LEGACY_A]));

    const { result } = render();
    await waitFor(() =>
      expect(result.current.selectedSessionIds).toEqual([REMOTE_ID]),
    );

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("migrates legacy localStorage selection into the database when remote is empty", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([LEGACY_B, 42, LEGACY_A, LEGACY_B]),
    );
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse({ threads: null });
        putBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          threads: row(
            (JSON.parse(String(init?.body)) as { session_ids: string[] })
              .session_ids,
          ),
        });
      },
    );

    const { result } = render();
    await waitFor(() =>
      expect(result.current.selectedSessionIds).toEqual([
        LEGACY_B,
        LEGACY_A,
      ]),
    );
    await waitFor(() =>
      expect(putBodies).toContainEqual({
        session_ids: [LEGACY_B, LEGACY_A],
      }),
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("normalizes updates and flushes the latest value when the page unmounts", async () => {
    const { result, unmount } = render();
    await waitFor(() =>
      expect(result.current.selectedSessionIds).toEqual([REMOTE_ID]),
    );

    act(() => {
      result.current.setSelectedSessionIds((previous) => [
        ...previous,
        NEW_ID,
        42 as unknown as string,
        NEW_ID,
      ]);
    });
    await waitFor(() =>
      expect(result.current.selectedSessionIds).toEqual([
        REMOTE_ID,
        NEW_ID,
      ]),
    );

    unmount();
    await waitFor(() =>
      expect(putBodies).toContainEqual({
        session_ids: [REMOTE_ID, NEW_ID],
      }),
    );
  });

  it("keeps a localStorage fallback when the database write fails", async () => {
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") return jsonResponse({ threads: null });
        throw new Error("network down");
      },
    );

    const { result, unmount } = render();
    await waitFor(() => expect(result.current.selectedSessionIds).toEqual([]));

    act(() => {
      result.current.setSelectedSessionIds([FALLBACK_ID]);
    });
    await waitFor(() =>
      expect(result.current.selectedSessionIds).toEqual([FALLBACK_ID]),
    );
    unmount();

    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"),
      ).toEqual([FALLBACK_ID]),
    );
  });
});

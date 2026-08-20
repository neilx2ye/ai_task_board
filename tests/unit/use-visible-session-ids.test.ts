// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { useVisibleSessionIds } from "@/hooks/use-visible-session-ids";

const STORAGE_KEY = "ai-task-board:visible-session-ids";
const LEGACY_HIDDEN_STORAGE_KEY = "ai-task-board:hidden-session-ids";
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

describe("visible Session database state", () => {
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
          threads: {
            visible_session_ids: (
              JSON.parse(String(init?.body)) as { session_ids: string[] }
            ).session_ids,
          },
        });
      }
      if (method === "GET") {
        return jsonResponse({
          threads: { visible_session_ids: [REMOTE_ID] },
        });
      }
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
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return {
      queryClient,
      ...renderHook(() => useVisibleSessionIds(), { wrapper }),
    };
  }

  it("restores the remote visibility set and drops the legacy localStorage copy", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([LEGACY_A]));
    window.localStorage.setItem(
      LEGACY_HIDDEN_STORAGE_KEY,
      JSON.stringify(["some-hidden"]),
    );

    const { result } = render();
    await waitFor(() =>
      expect([...result.current.visibleIds]).toEqual([REMOTE_ID]),
    );

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LEGACY_HIDDEN_STORAGE_KEY)).toBeNull();
  });

  it("migrates legacy visibility into the database when remote is empty", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([LEGACY_B, 42, LEGACY_A, LEGACY_B]),
    );
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return jsonResponse({
            threads: { visible_session_ids: [] },
          });
        }
        putBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          threads: {
            visible_session_ids: (
              JSON.parse(String(init?.body)) as { session_ids: string[] }
            ).session_ids,
          },
        });
      },
    );

    const { result } = render();
    await waitFor(() =>
      expect([...result.current.visibleIds]).toEqual([LEGACY_B, LEGACY_A]),
    );
    await waitFor(() =>
      expect(putBodies).toContainEqual({
        session_ids: [LEGACY_B, LEGACY_A],
      }),
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("persists toggle changes and flushes the latest value on unmount", async () => {
    const { result, unmount } = render();
    await waitFor(() =>
      expect([...result.current.visibleIds]).toEqual([REMOTE_ID]),
    );

    act(() => {
      result.current.setSessionVisible(NEW_ID, true);
    });
    await waitFor(() =>
      expect([...result.current.visibleIds]).toEqual([REMOTE_ID, NEW_ID]),
    );

    act(() => {
      result.current.setSessionVisible(REMOTE_ID, false);
    });
    await waitFor(() =>
      expect([...result.current.visibleIds]).toEqual([NEW_ID]),
    );

    unmount();
    await waitFor(() =>
      expect(putBodies).toContainEqual({ session_ids: [NEW_ID] }),
    );
  });

  it("keeps a localStorage fallback when the database write fails", async () => {
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          return jsonResponse({ threads: { visible_session_ids: [] } });
        }
        throw new Error("network down");
      },
    );

    const { result, unmount } = render();
    await waitFor(() =>
      expect(result.current.visibleIds.size).toBe(0),
    );

    act(() => {
      result.current.setSessionVisible(FALLBACK_ID, true);
    });
    await waitFor(() =>
      expect([...result.current.visibleIds]).toEqual([FALLBACK_ID]),
    );
    unmount();

    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"),
      ).toEqual([FALLBACK_ID]),
    );
  });
});

// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useSelectedSessionIds } from "@/hooks/use-selected-session-ids";

const STORAGE_KEY = "ai-task-board:selected-session-ids";

describe("selected Session browser state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("restores the opened Thread order and persists later changes", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(["thread-b", 42, "thread-a", "thread-b"]),
    );

    const first = renderHook(() => useSelectedSessionIds());
    expect(first.result.current.selectedSessionIds).toEqual([
      "thread-b",
      "thread-a",
    ]);

    act(() => {
      first.result.current.setSelectedSessionIds((previous) => [
        ...previous,
        "thread-c",
      ]);
    });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual(
      ["thread-b", "thread-a", "thread-c"],
    );
    first.unmount();

    const restored = renderHook(() => useSelectedSessionIds());
    expect(restored.result.current.selectedSessionIds).toEqual([
      "thread-b",
      "thread-a",
      "thread-c",
    ]);
  });
});

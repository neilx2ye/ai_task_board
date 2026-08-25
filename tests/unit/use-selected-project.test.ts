// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useSelectedProject } from "@/hooks/use-selected-project";

const STORAGE_KEY = "ai-task-board:selected-project";

describe("selected Project browser state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 全部 when storage is empty", () => {
    const { result } = renderHook(() => useSelectedProject());

    expect(result.current.selectedProjectId).toBeNull();
  });

  it("restores the selected project and persists later changes", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify("path:/workspace/app"),
    );

    const first = renderHook(() => useSelectedProject());
    expect(first.result.current.selectedProjectId).toBe("path:/workspace/app");

    act(() => {
      first.result.current.setSelectedProjectId(null);
    });
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '""'),
    ).toBeNull();
    first.unmount();

    const restored = renderHook(() => useSelectedProject());
    expect(restored.result.current.selectedProjectId).toBeNull();
  });

  it("falls back to 全部 for malformed storage values", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    const numeric = renderHook(() => useSelectedProject());
    expect(numeric.result.current.selectedProjectId).toBeNull();
    numeric.unmount();

    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const broken = renderHook(() => useSelectedProject());
    expect(broken.result.current.selectedProjectId).toBeNull();
  });
});

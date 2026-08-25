// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useHiddenProjects } from "@/hooks/use-hidden-projects";

const STORAGE_KEY = "ai-task-board:hidden-project-ids";

describe("hidden Project browser state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to an empty set and persists toggles", () => {
    const first = renderHook(() => useHiddenProjects());
    expect([...first.result.current.hiddenProjectIds]).toEqual([]);

    act(() => {
      first.result.current.setProjectHidden("path:/workspace/app", true);
    });
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"),
    ).toEqual(["path:/workspace/app"]);
    first.unmount();

    const restored = renderHook(() => useHiddenProjects());
    expect(restored.result.current.hiddenProjectIds.has("path:/workspace/app")).toBe(
      true,
    );

    act(() => {
      restored.result.current.setProjectHidden("path:/workspace/app", false);
    });
    expect(restored.result.current.hiddenProjectIds.size).toBe(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("ignores malformed storage values", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const broken = renderHook(() => useHiddenProjects());
    expect(broken.result.current.hiddenProjectIds.size).toBe(0);
    broken.unmount();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([42, "ok"]));
    const mixed = renderHook(() => useHiddenProjects());
    expect([...mixed.result.current.hiddenProjectIds]).toEqual(["ok"]);
  });
});

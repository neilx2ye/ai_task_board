// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useRemovedProjects } from "@/hooks/use-removed-projects";

const STORAGE_KEY = "ai-task-board:removed-project-ids";

describe("removed Project browser state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to an empty set and persists toggles", () => {
    const first = renderHook(() => useRemovedProjects());
    expect([...first.result.current.removedProjectIds]).toEqual([]);

    act(() => {
      first.result.current.setProjectRemoved("path:/workspace/app", true);
    });
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"),
    ).toEqual(["path:/workspace/app"]);
    first.unmount();

    const restored = renderHook(() => useRemovedProjects());
    expect(
      restored.result.current.removedProjectIds.has("path:/workspace/app"),
    ).toBe(true);

    act(() => {
      restored.result.current.setProjectRemoved(
        "path:/workspace/app",
        false,
      );
    });
    expect(restored.result.current.removedProjectIds.size).toBe(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("ignores malformed storage values", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const broken = renderHook(() => useRemovedProjects());
    expect(broken.result.current.removedProjectIds.size).toBe(0);
    broken.unmount();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([42, "ok"]));
    const mixed = renderHook(() => useRemovedProjects());
    expect([...mixed.result.current.removedProjectIds]).toEqual(["ok"]);
  });
});

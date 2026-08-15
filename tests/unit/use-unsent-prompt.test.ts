// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  readUnsentPrompt,
  unsentPromptStorageKey,
  useUnsentPrompt,
  writeUnsentPrompt,
} from "@/hooks/use-unsent-prompt";

describe("unsent Prompt browser storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("restores a saved draft when a Thread mounts", async () => {
    writeUnsentPrompt("thread-a", "帮我整理本周计划");

    const { result } = renderHook(() => useUnsentPrompt("thread-a"));
    await waitFor(() => {
      expect(result.current.draft).toBe("帮我整理本周计划");
    });
  });

  it("persists edits and removes the draft once it is cleared", async () => {
    const { result } = renderHook(() => useUnsentPrompt("thread-a"));
    await waitFor(() => {
      expect(result.current.draft).toBe("");
    });

    act(() => {
      result.current.setDraft("新的草稿");
    });
    expect(readUnsentPrompt("thread-a")).toBe("新的草稿");

    act(() => {
      result.current.setDraft("");
    });
    expect(readUnsentPrompt("thread-a")).toBe("");
    expect(
      window.localStorage.getItem(
        unsentPromptStorageKey("thread-a") ?? "",
      ),
    ).toBeNull();
  });

  it("keeps drafts separate for each Thread", async () => {
    writeUnsentPrompt("thread-a", "A 的草稿");
    writeUnsentPrompt("thread-b", "B 的草稿");

    const { result, rerender } = renderHook(
      ({ sessionId }) => useUnsentPrompt(sessionId),
      { initialProps: { sessionId: "thread-a" } },
    );
    await waitFor(() => {
      expect(result.current.draft).toBe("A 的草稿");
    });

    rerender({ sessionId: "thread-b" });
    await waitFor(() => {
      expect(result.current.draft).toBe("B 的草稿");
    });
    expect(readUnsentPrompt("thread-a")).toBe("A 的草稿");
  });
});

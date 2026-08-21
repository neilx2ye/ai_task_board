// @vitest-environment jsdom

import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StopRunningTaskDialog } from "@/components/stop-running-task-dialog";
import type { SessionListItem } from "@/lib/types/domain";

const session = {
  id: "session-1",
  name: "修复登录",
  current_task: {
    id: "task-1",
    title: "修复登录跳转",
    status: "running",
    progress_note: null,
    progress_percent_estimate: null,
    updated_at: "2026-08-21T00:00:00.000Z",
    awaiting_user_input: false,
  },
} as SessionListItem;

function renderDialog({
  onOpenChange = vi.fn(),
  onStopped = vi.fn(),
}: {
  onOpenChange?: (open: boolean) => void;
  onStopped?: (notice: string) => void;
} = {}) {
  const queryClient = new QueryClient();
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(StopRunningTaskDialog, {
        session,
        open: true,
        onOpenChange,
        onStopped,
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stop running task dialog", () => {
  it("pauses the running task, refreshes sessions, and reports the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { task: { id: "task-1" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onOpenChange = vi.fn();
    const onStopped = vi.fn();
    renderDialog({ onOpenChange, onStopped });

    fireEvent.click(screen.getByRole("button", { name: "停止运行" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/tasks/task-1/pause",
        expect.objectContaining({ method: "POST" }),
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onStopped).toHaveBeenCalledWith(
        expect.stringContaining("修复登录跳转"),
      );
    });
  });

  it("explains aggregate parents instead of failing with the raw API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "INVALID_STATE_TRANSITION",
            message: "The requested task state transition is invalid",
          },
        }),
      }),
    );
    const onOpenChange = vi.fn();
    const onStopped = vi.fn();
    renderDialog({ onOpenChange, onStopped });

    fireEvent.click(screen.getByRole("button", { name: "停止运行" }));

    await waitFor(() => {
      expect(
        screen.getByRole("alert").textContent,
      ).toContain("该任务包含子任务");
    });
    expect(onStopped).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

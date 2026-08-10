import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HistorySyncStatus,
  historySyncUiState,
} from "@/components/session-conversation-dialog";

const historySync = {
  status: "syncing" as const,
  turn_limit: 50,
  scanned_turns: 12,
  total_turns: 30,
  imported_items: 25,
  next_cursor: "opaque:next",
  error: null,
  started_at: "2026-08-10T00:00:00.000Z",
  completed_at: null,
  updated_at: "2026-08-10T00:01:00.000Z",
};

describe("session history UI state", () => {
  it("does not infer a pending apply when no sync record exists", () => {
    expect(historySyncUiState(null, null)).toBe("unauthorized");
    expect(historySyncUiState(null, "0.3.9")).toBe("unauthorized");
    expect(historySyncUiState(null, "0.4.0")).toBe("not-started");
  });

  it.each(["syncing", "partial", "complete", "failed"] as const)(
    "surfaces the backend %s state",
    (status) => {
      expect(historySyncUiState({ ...historySync, status }, "0.4.0")).toBe(
        status,
      );
    },
  );

  it("renders the backend status and cumulative statistics", () => {
    const markup = renderToStaticMarkup(
      createElement(HistorySyncStatus, {
        historySync: { ...historySync, status: "partial" },
        bridgeVersion: "0.4.0",
      }),
    );

    expect(markup).toContain('data-history-sync-state="partial"');
    expect(markup).toContain("历史同步部分完成");
    expect(markup).toContain("受安全扫描上限截断");
    expect(markup).toContain("调整 Web 与本机上限并检查设备日志");
    expect(markup).toContain("已扫描 12/30 turns");
    expect(markup).toContain("已导入 25 条");
    expect(markup).toContain("本次上限 50 turns");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ThreadPickerProjectList } from "@/components/thread-picker-dialog";
import type { SessionDirectoryGroup } from "@/lib/domain/session-directory-groups";
import type { SessionListItem } from "@/lib/types/domain";

function session(id: string, name: string, workingDirectory: string) {
  return {
    id,
    name,
    working_directory: workingDirectory,
    platform: "Codex",
    model: null,
    status: "offline",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    archived_at: null,
    inventory_active: true,
    current_task: null,
    queued_task_count: 0,
  } as SessionListItem;
}

describe("ThreadPickerProjectList", () => {
  it("renders Threads in separate project sections", () => {
    const projects: SessionDirectoryGroup[] = [
      {
        id: "configured:app",
        directoryKey: "app",
        name: "主应用",
        workingDirectory: "/workspace/app",
        inventoryActive: true,
        configured: true,
        sessions: [session("thread-app", "修复登录", "/workspace/app")],
      },
      {
        id: "configured:docs",
        directoryKey: "docs",
        name: "文档站",
        workingDirectory: "/workspace/docs",
        inventoryActive: true,
        configured: true,
        sessions: [session("thread-docs", "更新指南", "/workspace/docs")],
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(ThreadPickerProjectList, {
        projects,
        visibleIds: new Set(["thread-app"]),
        onToggle: vi.fn(),
        onOpen: vi.fn(),
        canManage: true,
        onRename: vi.fn(),
        onDelete: vi.fn(),
      }),
    );

    const appProjectStart = markup.indexOf('aria-label="项目「主应用」"');
    const docsProjectStart = markup.indexOf('aria-label="项目「文档站」"');
    const appProjectMarkup = markup.slice(appProjectStart, docsProjectStart);
    const docsProjectMarkup = markup.slice(docsProjectStart);

    expect(appProjectStart).toBeGreaterThanOrEqual(0);
    expect(docsProjectStart).toBeGreaterThan(appProjectStart);
    expect(appProjectMarkup).toContain("修复登录");
    expect(appProjectMarkup).not.toContain("更新指南");
    expect(docsProjectMarkup).toContain("更新指南");
    expect(docsProjectMarkup).not.toContain("修复登录");
  });
});

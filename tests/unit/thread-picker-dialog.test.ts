import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SessionDirectoryNavigation } from "@/components/session-directory-navigation";
import { ThreadPickerList } from "@/components/thread-picker-dialog";
import type { SessionDirectoryGroup } from "@/lib/domain/session-directory-groups";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";

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

const connection: SessionConnectionSummary = {
  id: "connection-1",
  name: "开发设备",
  platform: "Codex",
  last_seen_at: null,
  bridge_version: "0.7.0",
  revoked_at: null,
};

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

describe("project-scoped Thread management", () => {
  it("renders one management button for each project", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionDirectoryNavigation, {
        groups: [
          {
            connection,
            sessions: projects.flatMap((project) => project.sessions),
            directories: projects,
          },
        ],
        visibleIds: new Set<string>(),
        selectedSessionIds: [],
        isOwner: true,
        onToggleSession: vi.fn(),
        onReserve: vi.fn(),
        onManage: vi.fn(),
        onCreate: vi.fn(),
      }),
    );

    expect(markup).toContain('aria-label="管理项目「主应用」的 Threads"');
    expect(markup).toContain('aria-label="管理项目「文档站」的 Threads"');
    expect(markup).not.toContain(
      'aria-label="选择「开发设备」要显示的 Threads"',
    );
  });

  it("renders only the Threads passed from the selected project", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadPickerList, {
        sessions: projects[0].sessions,
        visibleIds: new Set(["thread-app"]),
        onToggle: vi.fn(),
        onOpen: vi.fn(),
        canManage: true,
        onRename: vi.fn(),
        onDelete: vi.fn(),
      }),
    );

    expect(markup).toContain("修复登录");
    expect(markup).not.toContain("更新指南");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SessionDirectoryNavigation } from "@/components/session-directory-navigation";
import {
  clampThreadPickerDialogWidth,
  getUnselectedThreadDeletePlan,
  ThreadPickerList,
} from "@/components/thread-picker-dialog";
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

  it("does not render removed projects", () => {
    const removedProject: SessionDirectoryGroup = {
      id: "configured:removed",
      directoryKey: "removed",
      name: "已删除项目",
      workingDirectory: "/workspace/removed",
      inventoryActive: false,
      configured: true,
      sessions: [session("thread-removed", "已删除会话", "/workspace/removed")],
    };
    const markup = renderToStaticMarkup(
      createElement(SessionDirectoryNavigation, {
        groups: [
          {
            connection,
            sessions: [...projects[0].sessions, ...removedProject.sessions],
            directories: [projects[0], removedProject],
          },
        ],
        visibleIds: new Set(["thread-app", "thread-removed"]),
        selectedSessionIds: [],
        isOwner: true,
        onToggleSession: vi.fn(),
        onReserve: vi.fn(),
        onManage: vi.fn(),
        onCreate: vi.fn(),
      }),
    );

    expect(markup).toContain("主应用");
    expect(markup).not.toContain("已删除项目");
    expect(markup).not.toContain("已删除会话");
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

  it("hides rename while keeping delete for Kimi ACP Sessions", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadPickerList, {
        sessions: projects[0].sessions,
        visibleIds: new Set(["thread-app"]),
        onToggle: vi.fn(),
        onOpen: vi.fn(),
        canManage: true,
        canRename: false,
        onRename: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    expect(markup).not.toContain('aria-label="重命名 Thread');
    expect(markup).toContain('aria-label="删除 Thread');
  });

  it("bulk-deletes only unchecked Threads that are currently deletable", () => {
    const selected = session("thread-selected", "保留", "/workspace/app");
    const deletable = session("thread-delete", "删除", "/workspace/app");
    const busy = {
      ...session("thread-busy", "任务处理中", "/workspace/app"),
      queued_task_count: 1,
    };
    const inactive = {
      ...session("thread-inactive", "已离开清单", "/workspace/app"),
      inventory_active: false,
    };

    const plan = getUnselectedThreadDeletePlan(
      [selected, deletable, busy, inactive],
      new Set([selected.id]),
    );

    expect(plan.sessions.map((candidate) => candidate.id)).toEqual([
      deletable.id,
    ]);
    expect(plan.skippedCount).toBe(2);
  });

  it("keeps a resized management dialog within the viewport bounds", () => {
    expect(clampThreadPickerDialogWidth(720, 1_280)).toBe(720);
    expect(clampThreadPickerDialogWidth(300, 1_280)).toBe(480);
    expect(clampThreadPickerDialogWidth(2_000, 1_280)).toBe(1_248);
    expect(clampThreadPickerDialogWidth(672, 420)).toBe(388);
  });
});

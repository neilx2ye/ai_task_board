import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectBridgeNavigation } from "@/components/project-bridge-navigation";
import type { SessionProjectBridgeGroup } from "@/lib/domain/session-directory-groups";
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

const laptopConnection: SessionConnectionSummary = {
  id: "connection-1",
  name: "开发笔记本",
  platform: "Codex",
  last_seen_at: null,
  bridge_version: "0.7.0",
  revoked_at: null,
};

const desktopConnection: SessionConnectionSummary = {
  ...laptopConnection,
  id: "connection-2",
  name: "工作台式机",
};

function render(
  projects: SessionProjectBridgeGroup[],
  visibleIds: ReadonlySet<string> = new Set<string>(),
) {
  return renderToStaticMarkup(
    createElement(ProjectBridgeNavigation, {
      projects,
      visibleIds,
      selectedSessionIds: [],
      isOwner: true,
      onToggleSession: vi.fn(),
      onManage: vi.fn(),
      onCreate: vi.fn(),
    }),
  );
}

describe("Project-first Bridge navigation", () => {
  const project: SessionProjectBridgeGroup = {
    id: "path:/workspace/app",
    name: "主应用",
    workingDirectory: "/workspace/app",
    sessionCount: 2,
    runningTaskCount: 1,
    unviewedCompletedCount: 0,
    bridges: [
      {
        groupId: "connection-1",
        platform: null,
        connection: laptopConnection,
        directory: {
          id: "configured:app",
          directoryKey: "app",
          name: "主应用",
          workingDirectory: "/workspace/app",
          inventoryActive: true,
          configured: true,
          sessions: [
            session("thread-a", "修复登录", "/workspace/app"),
          ],
        },
      },
      {
        groupId: "connection-2",
        platform: null,
        connection: desktopConnection,
        directory: {
          id: "configured:app",
          directoryKey: "app",
          name: "主应用",
          workingDirectory: "/workspace/app",
          inventoryActive: true,
          configured: true,
          sessions: [session("thread-b", "清理依赖", "/workspace/app")],
        },
      },
    ],
  };

  it("renders the project above its access Bridges", () => {
    const markup = render([project]);

    expect(markup.indexOf("主应用")).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf("主应用")).toBeLessThan(
      markup.indexOf("开发笔记本"),
    );
    expect(markup.indexOf("开发笔记本")).toBeLessThan(
      markup.indexOf("工作台式机"),
    );
    expect(markup).toContain("/workspace/app");
    expect(markup).toContain('aria-label="项目、Bridge 与 Thread 列表"');
  });

  it("keeps per-Bridge management and creation entry points", () => {
    const markup = render(
      [project],
      new Set(["thread-a", "thread-b"]),
    );

    expect(markup).toContain(
      'aria-label="管理项目「主应用」在 Bridge「开发笔记本」的 Threads"',
    );
    expect(markup).toContain(
      'aria-label="管理项目「主应用」在 Bridge「工作台式机」的 Threads"',
    );
    expect(markup).toContain("修复登录");
    expect(markup).toContain("清理依赖");
  });

  it("marks a Bridge with access but no Threads", () => {
    const emptyProject: SessionProjectBridgeGroup = {
      ...project,
      sessionCount: 0,
      bridges: [
        {
          groupId: "connection-1",
          platform: null,
          connection: laptopConnection,
          directory: {
            ...project.bridges[0].directory,
            sessions: [],
          },
        },
      ],
    };

    const markup = render([emptyProject]);
    expect(markup).toContain("暂无 Thread");
    // 平台徽标与 Thread 数需要和「管理 Threads / 新建 Thread」一起可见。
    expect(markup).toContain(">Codex<");
    expect(markup).toContain('title="Thread 数"');
  });

  it("keeps the project header as the cross-Bridge planning trigger", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectBridgeNavigation, {
        projects: [project],
        visibleIds: new Set(["thread-a"]),
        selectedSessionIds: [],
        isOwner: true,
        onToggleSession: vi.fn(),
        onManage: vi.fn(),
        onCreate: vi.fn(),
        onSelectProject: vi.fn(),
      }),
    );

    expect(markup).toContain(
      'aria-label="选中项目「主应用」的项目规划"',
    );
    expect(markup).toContain('title="打开项目级规划"');
  });

  it("shows a stop control only for Threads with a running task", () => {
    const runningSession = {
      ...session("thread-a", "修复登录", "/workspace/app"),
      current_task: {
        id: "task-1",
        title: "修复登录跳转",
        status: "running" as const,
        progress_note: null,
        progress_percent_estimate: null,
        updated_at: "2026-08-11T00:00:00.000Z",
        awaiting_user_input: false,
      },
    };
    const runningProject: SessionProjectBridgeGroup = {
      ...project,
      bridges: [
        {
          ...project.bridges[0],
          directory: {
            ...project.bridges[0].directory,
            sessions: [
              runningSession,
              session("thread-idle", "清理依赖", "/workspace/app"),
            ],
          },
        },
      ],
    };

    const markup = renderToStaticMarkup(
      createElement(ProjectBridgeNavigation, {
        projects: [runningProject],
        visibleIds: new Set(["thread-a", "thread-idle"]),
        selectedSessionIds: [],
        isOwner: true,
        onToggleSession: vi.fn(),
        onManage: vi.fn(),
        onCreate: vi.fn(),
        onStopRunningTask: vi.fn(),
      }),
    );

    expect(markup).toContain(
      'aria-label="停止 Thread「修复登录」正在运行的任务「修复登录跳转」"',
    );
    expect(markup.match(/aria-label="停止 Thread/g)).toHaveLength(1);
  });
});

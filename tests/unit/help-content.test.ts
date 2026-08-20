import { describe, expect, it } from "vitest";

import {
  BRIDGE_INSTALL_PACKAGE,
  HELP_ACTIONS,
  HELP_SECTIONS,
} from "@/components/help-content";

describe("帮助页结构元数据", () => {
  it("安装命令使用 latest 标签跟随最新发布", () => {
    expect(BRIDGE_INSTALL_PACKAGE).toBe("ai-task-board-bridge@latest");
  });

  it("目录锚点 id 唯一且非空", () => {
    const ids = HELP_SECTIONS.map((section) => section.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("目录覆盖关键章节", () => {
    const ids = HELP_SECTIONS.map((section) => section.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "getting-started",
        "task-status",
        "ai-integration",
        "attachments",
        "faq",
      ]),
    );
  });

  it("快速操作链接指向已实现的核心页面", () => {
    expect(HELP_ACTIONS.map((action) => action.href)).toEqual([
      "/sessions",
      "/connections",
      "/planning",
      "/files",
    ]);
    for (const action of HELP_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.description.length).toBeGreaterThan(0);
    }
  });
});

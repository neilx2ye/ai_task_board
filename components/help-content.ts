/**
 * 帮助页的结构化目录与操作链接，供页面渲染与轻量单测复用。
 */

export type HelpSection = {
  /** 锚点 id，同时用于目录链接 href="#id"。 */
  id: string;
  label: string;
};

/**
 * 帮助页安装命令固定的 Bridge npm 包名与版本。发布新版时只需修改这里，
 * 并与 packages/codex-bridge/package.json 的 version 保持一致（有单测守护）。
 */
export const BRIDGE_INSTALL_PACKAGE = "ai-task-board-bridge@1.7.1";

export const HELP_SECTIONS: ReadonlyArray<HelpSection> = [
  { id: "getting-started", label: "新设备配置" },
  { id: "unified-bridge", label: "统一设备 Bridge" },
  { id: "codex-bridge", label: "Codex Bridge" },
  { id: "kimi-bridge", label: "Kimi Bridge" },
  { id: "antigravity-bridge", label: "Antigravity Bridge" },
  { id: "claude-code-bridge", label: "Claude Code Bridge" },
  { id: "bridge-updates", label: "Bridge 升级与回滚" },
  { id: "task-status", label: "任务状态" },
  { id: "ai-integration", label: "AI 接入" },
  { id: "attachments", label: "附件" },
  { id: "faq", label: "常见问题" },
];

export type HelpAction = {
  href: string;
  label: string;
  description: string;
};

export const HELP_ACTIONS: ReadonlyArray<HelpAction> = [
  {
    href: "/sessions",
    label: "查看会话与上下文",
    description: "按连接查看会话、执行历史，并直接发送下一任务",
  },
  {
    href: "/connections",
    label: "管理 AI 连接",
    description: "创建连接并获取一次性令牌",
  },
  {
    href: "/planning",
    label: "打开任务规划",
    description:
      "查看跨 Bridge 的项目规划笔记，以及每个 Thread 独立的思考笔记与 Turn 规划链",
  },
  {
    href: "/files",
    label: "浏览设备文件",
    description: "按已上报的工作目录预览设备上的项目文件",
  },
];

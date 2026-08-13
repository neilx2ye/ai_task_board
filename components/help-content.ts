/**
 * 帮助页的结构化目录与操作链接，供页面渲染与轻量单测复用。
 */

export type HelpSection = {
  /** 锚点 id，同时用于目录链接 href="#id"。 */
  id: string;
  label: string;
};

export const HELP_SECTIONS: ReadonlyArray<HelpSection> = [
  { id: "getting-started", label: "新设备配置" },
  { id: "codex-bridge", label: "Codex Bridge" },
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
];

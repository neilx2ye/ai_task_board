import type { SessionStatus, TaskStatus } from "@/lib/types/database";

type StatusMeta = {
  label: string;
  /** 徽标样式：浅色底 + 深色字，避免过度渐变。 */
  badgeClass: string;
  /** 看板卡片左侧的状态条颜色。 */
  barClass: string;
};

export const TASK_STATUS_META: Record<TaskStatus, StatusMeta> = {
  inbox: {
    label: "未绑定（历史）",
    badgeClass: "border-stone-200 bg-stone-100 text-stone-700",
    barClass: "bg-stone-300",
  },
  ready: {
    label: "已预留",
    badgeClass: "border-teal-200 bg-teal-50 text-teal-700",
    barClass: "bg-teal-500",
  },
  claimed: {
    label: "会话已接收",
    badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-700",
    barClass: "bg-indigo-400",
  },
  running: {
    label: "执行中",
    badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-700",
    barClass: "bg-indigo-500",
  },
  waiting_user: {
    label: "等我回复",
    badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
    barClass: "bg-amber-500",
  },
  blocked: {
    label: "已阻塞",
    badgeClass: "border-orange-200 bg-orange-50 text-orange-800",
    barClass: "bg-orange-400",
  },
  completed: {
    label: "已完成",
    badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
    barClass: "bg-emerald-500",
  },
  failed: {
    label: "已失败",
    badgeClass: "border-red-200 bg-red-50 text-red-700",
    barClass: "bg-red-500",
  },
  cancelled: {
    label: "已取消",
    badgeClass: "border-stone-200 bg-stone-100 text-stone-500",
    barClass: "bg-stone-300",
  },
};

export const SESSION_STATUS_META: Record<
  SessionStatus,
  { label: string; badgeClass: string }
> = {
  online: {
    label: "在线",
    badgeClass: "border-teal-200 bg-teal-50 text-teal-700",
  },
  busy: {
    label: "忙碌",
    badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-700",
  },
  waiting: {
    label: "等待用户",
    badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
  },
  offline: {
    label: "离线",
    badgeClass: "border-stone-200 bg-stone-100 text-stone-600",
  },
};

export const ACTOR_TYPE_LABEL: Record<"user" | "ai" | "system", string> = {
  user: "用户",
  ai: "AI",
  system: "系统",
};

export type PriorityLevel = {
  label: string;
  value: number;
  badgeClass: string;
};

export const PRIORITY_LEVELS: PriorityLevel[] = [
  { label: "低", value: 10, badgeClass: "border-stone-200 bg-stone-100 text-stone-600" },
  { label: "普通", value: 50, badgeClass: "border-stone-200 bg-stone-100 text-stone-700" },
  { label: "高", value: 80, badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-700" },
  { label: "紧急", value: 100, badgeClass: "border-red-200 bg-red-50 text-red-700" },
];

export function priorityLevelOf(priority: number): PriorityLevel {
  if (priority >= 95) return PRIORITY_LEVELS[3];
  if (priority >= 70) return PRIORITY_LEVELS[2];
  if (priority >= 40) return PRIORITY_LEVELS[1];
  return PRIORITY_LEVELS[0];
}

export const EVENT_TYPE_LABEL: Record<string, string> = {
  task_created: "创建任务",
  task_updated: "更新任务",
  task_claimed: "会话接收任务",
  task_started: "开始执行",
  progress_reported: "回传进度",
  session_activity_reported: "同步会话活动",
  subtasks_created: "拆分任务",
  user_input_requested: "请求用户输入",
  structured_user_input_requested: "等待 Web 结构化回答",
  structured_user_input_answered: "Web 结构化回答已提交",
  user_replied: "用户已回复",
  task_completed: "完成任务",
  task_failed: "任务失败",
  task_released: "释放任务",
  task_cancelled: "取消任务",
  task_reopened: "重新打开",
  session_assigned: "指定会话",
  session_unassigned: "解除指定",
  message_posted: "新消息",
};

export function eventTypeLabel(type: string): string {
  return EVENT_TYPE_LABEL[type] ?? type;
}

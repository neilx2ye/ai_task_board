import type { TaskStatus } from "@/lib/types/database";

export type AssignmentPatch =
  | { include: true; value: string | null }
  | { include: false };

export type AssignmentContext = {
  isEdit: boolean;
  status: TaskStatus;
  /** 任务是否已有子任务（聚合父任务）。 */
  hasChildren: boolean;
  original: string | null;
};

export type AssignmentInput = AssignmentContext & {
  selected: string | null;
};

/**
 * 计算编辑任务时 assigned_session_id 是否应出现在 PATCH 中。
 *
 * - 新建：始终包含（创建语义完整提交）。
 * - 聚合父（有子任务，规则优先于 claimed/running）：数据库禁止非 null 指派；
 *   仅允许保持历史异常原值（省略）或清空（发送 null），改派防御性省略。
 *   因此 running 聚合父也能清理历史异常指派。
 * - claimed / running：会话被锁定，任何情况下都省略。
 * - waiting_user：只允许保持原值或解除为 null；未变省略，解除发送 null，
 *   改派他人由界面禁止，此处在防御层面同样省略。
 * - 其他状态：仅在实际改变时包含。
 */
export function resolveAssignedSessionPatch(
  options: AssignmentInput,
): AssignmentPatch {
  const { isEdit, status, hasChildren, original, selected } = options;

  if (!isEdit) return { include: true, value: selected };

  if (hasChildren) {
    if (selected === original) return { include: false };
    if (selected === null) return { include: true, value: null };
    return { include: false };
  }

  if (status === "claimed" || status === "running") return { include: false };

  if (status === "waiting_user") {
    if (selected === original) return { include: false };
    if (selected === null) return { include: true, value: null };
    return { include: false };
  }

  if (selected === original) return { include: false };
  return { include: true, value: selected };
}

/**
 * 会话选择器是否禁用。
 * - 聚合父：原指派为空时禁止设置新指派（锁定）；有历史指派时保持可选以允许清空。
 * - 其他任务：claimed / running 锁定。
 */
export function isSessionSelectLocked(options: AssignmentContext): boolean {
  const { isEdit, status, hasChildren, original } = options;
  if (!isEdit) return false;
  if (hasChildren) return original === null;
  return status === "claimed" || status === "running";
}

/**
 * 受限状态下选择器允许的值。
 * - 聚合父：仅当前指派与“不指定”（清空历史异常值）。
 * - waiting_user：仅当前指派与“不指定”（解除）。
 * 其余情况返回 null，表示不限制选项。
 */
export function sessionOptionsForStatus(
  options: AssignmentContext,
): ReadonlyArray<string | null> | null {
  const { isEdit, status, hasChildren, original } = options;
  if (!isEdit) return null;
  if (hasChildren || status === "waiting_user") {
    return original ? [original, null] : [null];
  }
  return null;
}

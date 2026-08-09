import type { TaskMessageRow } from "@/lib/types/database";

/**
 * 从（可能聚合了后代的）消息列表中定位最新一条待回复的 AI 问题。
 * 只有 sender_type=ai、requires_response 且尚未读（read_at 为空）的消息
 * 才算待答；回复必须发送到该消息实际所属的 task_id。
 *
 * 可选 isWaitingTask 断言消息所属任务的当前状态：所属任务已不再是
 * waiting_user（例如被取消或已恢复）时，旧的未读问题不再视为待答，
 * 避免对一个必然 409 的目标展示“回复并恢复”。
 */
export function findPendingQuestion(
  messages: readonly TaskMessageRow[],
  isWaitingTask?: (taskId: string) => boolean,
): TaskMessageRow | null {
  let latest: TaskMessageRow | null = null;
  for (const message of messages) {
    if (
      message.sender_type !== "ai" ||
      !message.requires_response ||
      message.read_at != null
    ) {
      continue;
    }
    if (isWaitingTask && !isWaitingTask(message.task_id)) continue;
    if (!latest || message.created_at > latest.created_at) {
      latest = message;
    }
  }
  return latest;
}

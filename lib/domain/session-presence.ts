import type {
  AIConnectionRow,
  AISessionRow,
  SessionStatus,
} from "@/lib/types/database";

/**
 * 会话只有持续心跳才能作为 Web Console 的派发目标。
 * 客户端应至少每分钟调用一次 session heartbeat；两分钟没有活动就视为离线。
 */
export const SESSION_ALIVE_WINDOW_MS = 2 * 60 * 1000;
export const CONNECTION_ALIVE_WINDOW_MS = SESSION_ALIVE_WINDOW_MS;

export function isConnectionAlive(
  connection: Pick<AIConnectionRow, "last_seen_at" | "revoked_at">,
  now = Date.now(),
): boolean {
  if (connection.revoked_at || !connection.last_seen_at) return false;
  const lastSeenAt = Date.parse(connection.last_seen_at);
  return (
    Number.isFinite(lastSeenAt) &&
    now - lastSeenAt <= CONNECTION_ALIVE_WINDOW_MS
  );
}

export function isSessionAlive(
  session: Pick<
    AISessionRow,
    "archived_at" | "inventory_active" | "last_seen_at" | "status"
  >,
  now = Date.now(),
): boolean {
  if (
    !session.inventory_active ||
    session.archived_at !== null ||
    session.status === "offline"
  ) {
    return false;
  }
  const lastSeenAt = Date.parse(session.last_seen_at);
  return Number.isFinite(lastSeenAt) && now - lastSeenAt <= SESSION_ALIVE_WINDOW_MS;
}

export function effectiveSessionStatus(
  session: Pick<
    AISessionRow,
    "archived_at" | "inventory_active" | "last_seen_at" | "status"
  >,
  now = Date.now(),
): SessionStatus {
  return isSessionAlive(session, now) ? session.status : "offline";
}

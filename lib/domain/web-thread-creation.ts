import { canonicalBridgeKind } from "@/lib/agent-platforms";
import type { SessionListItem } from "@/lib/types/domain";

export type PendingWebThreadCreation = {
  connectionId: string;
  directoryKey: string | null;
  name: string;
  /** 新建 Thread 所属的规范运行时类型；null 时不做运行时过滤。 */
  platform?: string | null;
  existingSessionIds: readonly string[];
};

/**
 * A create command is asynchronous and does not know the eventual Session id.
 * Match the first inventory row that appeared after submission in the same
 * device/project with the Web-assigned display name.
 */
export function findCreatedWebThread(
  sessions: readonly SessionListItem[],
  pending: PendingWebThreadCreation,
): SessionListItem | null {
  const existingIds = new Set(pending.existingSessionIds);
  return (
    sessions.find(
      (session) =>
        session.connection_id === pending.connectionId &&
        !existingIds.has(session.id) &&
        session.name === pending.name &&
        (pending.platform == null ||
          canonicalBridgeKind(session.platform) ===
            canonicalBridgeKind(pending.platform)) &&
        (pending.directoryKey === null ||
          session.bridge_directory_key === pending.directoryKey),
    ) ?? null
  );
}

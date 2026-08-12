import type { SessionListItem } from "@/lib/types/domain";

export type PendingWebThreadCreation = {
  connectionId: string;
  directoryKey: string | null;
  name: string;
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
        (pending.directoryKey === null ||
          session.bridge_directory_key === pending.directoryKey),
    ) ?? null
  );
}

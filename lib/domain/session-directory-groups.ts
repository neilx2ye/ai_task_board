import type { AIBridgeDirectoryRow } from "@/lib/types/database";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";

export type SessionDirectoryGroup = {
  id: string;
  directoryKey: string | null;
  name: string;
  workingDirectory: string | null;
  inventoryActive: boolean;
  configured: boolean;
  sessions: SessionListItem[];
};

export type SessionConnectionGroup = {
  connection: SessionConnectionSummary;
  sessions: SessionListItem[];
  directories: SessionDirectoryGroup[];
};

function directoryNameFromPath(workingDirectory: string): string {
  const segments = workingDirectory.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) ?? workingDirectory;
}

export function groupSessionsByConnection(
  sessions: SessionListItem[],
  connections: SessionConnectionSummary[] = [],
  directories: AIBridgeDirectoryRow[] = [],
): SessionConnectionGroup[] {
  const groups = new Map<string, SessionConnectionGroup>();

  for (const connection of connections) {
    groups.set(connection.id, { connection, sessions: [], directories: [] });
  }

  for (const session of sessions) {
    const existing = groups.get(session.connection.id);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(session.connection.id, {
        connection: session.connection,
        sessions: [session],
        directories: [],
      });
    }
  }

  for (const group of groups.values()) {
    const directoryGroups = new Map<string, SessionDirectoryGroup>();
    const configuredByKey = new Map<string, SessionDirectoryGroup>();
    const configuredByPath = new Map<string, SessionDirectoryGroup>();

    for (const directory of directories) {
      if (directory.connection_id !== group.connection.id) continue;
      const directoryGroup: SessionDirectoryGroup = {
        id: `configured:${directory.directory_key}`,
        directoryKey: directory.directory_key,
        name: directory.name,
        workingDirectory: directory.working_directory,
        inventoryActive: directory.inventory_active,
        configured: true,
        sessions: [],
      };
      directoryGroups.set(directoryGroup.id, directoryGroup);
      configuredByKey.set(directory.directory_key, directoryGroup);
      configuredByPath.set(directory.working_directory, directoryGroup);
    }

    for (const session of group.sessions) {
      const configured =
        (session.bridge_directory_key
          ? configuredByKey.get(session.bridge_directory_key)
          : undefined) ??
        (session.working_directory
          ? configuredByPath.get(session.working_directory)
          : undefined);
      if (configured) {
        configured.sessions.push(session);
        continue;
      }

      const id = session.working_directory
        ? `path:${session.working_directory}`
        : "unassigned";
      let directoryGroup = directoryGroups.get(id);
      if (!directoryGroup) {
        directoryGroup = {
          id,
          directoryKey: null,
          name: session.working_directory
            ? directoryNameFromPath(session.working_directory)
            : "未归类",
          workingDirectory: session.working_directory,
          inventoryActive: session.inventory_active,
          configured: false,
          sessions: [],
        };
        directoryGroups.set(id, directoryGroup);
      }
      directoryGroup.inventoryActive ||= session.inventory_active;
      directoryGroup.sessions.push(session);
    }

    group.directories = [...directoryGroups.values()].sort((left, right) => {
      if (left.configured !== right.configured) return left.configured ? -1 : 1;
      if (left.inventoryActive !== right.inventoryActive) {
        return left.inventoryActive ? -1 : 1;
      }
      return (
        left.name.localeCompare(right.name, "zh-CN") ||
        (left.workingDirectory ?? "").localeCompare(
          right.workingDirectory ?? "",
        )
      );
    });
  }

  return [...groups.values()];
}

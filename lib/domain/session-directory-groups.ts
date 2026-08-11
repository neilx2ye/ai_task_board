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

function appendToIndex<T>(
  index: Map<string, T[]>,
  key: string,
  value: T,
) {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

function compareDirectoryGroups(
  left: SessionDirectoryGroup,
  right: SessionDirectoryGroup,
): number {
  if (left.configured !== right.configured) return left.configured ? -1 : 1;
  if (left.inventoryActive !== right.inventoryActive) {
    return left.inventoryActive ? -1 : 1;
  }
  return (
    left.name.localeCompare(right.name, "zh-CN") ||
    (left.workingDirectory ?? "").localeCompare(right.workingDirectory ?? "")
  );
}

function buildDirectoryGroups(
  sessions: readonly SessionListItem[],
  directories: readonly AIBridgeDirectoryRow[],
): SessionDirectoryGroup[] {
  const groups = new Map<string, SessionDirectoryGroup>();
  const configuredByKey = new Map<string, SessionDirectoryGroup>();
  const configuredByPath = new Map<string, SessionDirectoryGroup>();

  for (const directory of directories) {
    const group: SessionDirectoryGroup = {
      id: `configured:${directory.directory_key}`,
      directoryKey: directory.directory_key,
      name: directory.name,
      workingDirectory: directory.working_directory,
      inventoryActive: directory.inventory_active,
      configured: true,
      sessions: [],
    };
    groups.set(group.id, group);
    configuredByKey.set(directory.directory_key, group);
    configuredByPath.set(directory.working_directory, group);
  }

  for (const session of sessions) {
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
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        directoryKey: null,
        name: session.working_directory
          ? directoryNameFromPath(session.working_directory)
          : "未归类",
        workingDirectory: session.working_directory,
        inventoryActive: false,
        configured: false,
        sessions: [],
      };
      groups.set(id, group);
    }
    group.inventoryActive ||= session.inventory_active;
    group.sessions.push(session);
  }

  return [...groups.values()].sort(compareDirectoryGroups);
}

export function groupSessionsByConnection(
  sessions: readonly SessionListItem[],
  connections: readonly SessionConnectionSummary[] = [],
  directories: readonly AIBridgeDirectoryRow[] = [],
): SessionConnectionGroup[] {
  const sessionsByConnection = new Map<string, SessionListItem[]>();
  const directoriesByConnection = new Map<string, AIBridgeDirectoryRow[]>();
  const connectionById = new Map(
    connections.map((connection) => [connection.id, connection]),
  );

  for (const session of sessions) {
    if (!connectionById.has(session.connection.id)) {
      connectionById.set(session.connection.id, session.connection);
    }
    appendToIndex(sessionsByConnection, session.connection.id, session);
  }
  for (const directory of directories) {
    appendToIndex(
      directoriesByConnection,
      directory.connection_id,
      directory,
    );
  }

  return [...connectionById.values()].map((connection) => {
    const connectionSessions = sessionsByConnection.get(connection.id) ?? [];
    return {
      connection,
      sessions: connectionSessions,
      directories: buildDirectoryGroups(
        connectionSessions,
        directoriesByConnection.get(connection.id) ?? [],
      ),
    };
  });
}

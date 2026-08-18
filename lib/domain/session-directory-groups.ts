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

/**
 * 项目级视图：同一个 working directory 可能挂在多个 Bridge 下，
 * 项目 Tab 把它们按路径合并成一个可过滤的入口。
 */
export type SessionProjectGroup = {
  id: string;
  name: string;
  workingDirectory: string | null;
  sessionCount: number;
};

export type SessionProjectBridge = {
  connection: SessionConnectionSummary;
  directory: SessionDirectoryGroup;
};

/** 项目优先视图：一个项目下对该地址有权限的所有 Bridge。 */
export type SessionProjectBridgeGroup = SessionProjectGroup & {
  bridges: SessionProjectBridge[];
};

const UNASSIGNED_PROJECT_ID = "unassigned";

export function sessionProjectIdForDirectory(
  directory: Pick<SessionDirectoryGroup, "workingDirectory">,
): string {
  return directory.workingDirectory
    ? `path:${directory.workingDirectory}`
    : UNASSIGNED_PROJECT_ID;
}

export function directoryNameFromPath(workingDirectory: string): string {
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
    if (!session.inventory_active) continue;

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

  return [...groups.values()]
    .filter((group) => group.inventoryActive)
    .sort(compareDirectoryGroups);
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
    const existingConnection = connectionById.get(session.connection.id);
    if (!existingConnection) {
      connectionById.set(session.connection.id, session.connection);
    } else if (
      existingConnection.model_catalog == null &&
      session.connection.model_catalog != null
    ) {
      connectionById.set(session.connection.id, {
        ...existingConnection,
        model_catalog: session.connection.model_catalog,
        model_catalog_updated_at:
          session.connection.model_catalog_updated_at ?? null,
      });
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
    const connectionDirectories = buildDirectoryGroups(
      connectionSessions,
      directoriesByConnection.get(connection.id) ?? [],
    );
    const visibleSessionIds = new Set(
      connectionDirectories.flatMap((directory) =>
        directory.sessions.map((session) => session.id),
      ),
    );

    return {
      connection,
      sessions: connectionSessions.filter((session) =>
        visibleSessionIds.has(session.id),
      ),
      directories: connectionDirectories,
    };
  });
}

function compareProjects(
  left: SessionProjectGroup,
  right: SessionProjectGroup,
): number {
  // 未归类的项目固定排最后，其余按名称再按路径排序。
  const leftUnassigned = left.id === UNASSIGNED_PROJECT_ID;
  const rightUnassigned = right.id === UNASSIGNED_PROJECT_ID;
  if (leftUnassigned !== rightUnassigned) return leftUnassigned ? 1 : -1;
  return (
    left.name.localeCompare(right.name, "zh-CN") ||
    (left.workingDirectory ?? "").localeCompare(right.workingDirectory ?? "")
  );
}

/** 跨 Bridge 汇总项目 Tab：同一 working directory 合并为一个项目。 */
export function listSessionProjects(
  groups: readonly SessionConnectionGroup[],
): SessionProjectGroup[] {
  const projects = new Map<string, SessionProjectGroup>();

  for (const group of groups) {
    for (const directory of group.directories) {
      const id = sessionProjectIdForDirectory(directory);
      const existing = projects.get(id);
      if (existing) {
        existing.sessionCount += directory.sessions.length;
        // 任意一个 Bridge 配置了该目录时，优先展示配置里的目录名。
        if (directory.configured) existing.name = directory.name;
        continue;
      }
      projects.set(id, {
        id,
        name: directory.name,
        workingDirectory: directory.workingDirectory,
        sessionCount: directory.sessions.length,
      });
    }
  }

  return [...projects.values()].sort(compareProjects);
}

/**
 * 按项目过滤层级：只保留属于该项目的目录，重算每个 Bridge 的 Thread 列表；
 * 过滤后没有任何目录的 Bridge 整个隐藏。projectId 为 null 时表示「全部」，原样返回。
 */
export function filterConnectionGroupsByProject(
  groups: readonly SessionConnectionGroup[],
  projectId: string | null,
): SessionConnectionGroup[] {
  if (projectId === null) return [...groups];

  return groups.flatMap((group) => {
    const directories = group.directories.filter(
      (directory) => sessionProjectIdForDirectory(directory) === projectId,
    );
    if (directories.length === 0) return [];

    const visibleSessionIds = new Set(
      directories.flatMap((directory) =>
        directory.sessions.map((session) => session.id),
      ),
    );
    return [
      {
        ...group,
        directories,
        sessions: group.sessions.filter((session) =>
          visibleSessionIds.has(session.id),
        ),
      },
    ];
  });
}

/**
 * 项目优先视图：把「Bridge → 项目目录」重排为「项目 → Bridges」。
 * 同一个 working directory 有权限的多个 Bridge 会归到同一个项目下，
 * 项目名称与计数和顶部项目 Tab（listSessionProjects）保持一致。
 */
export function groupBridgesByProject(
  groups: readonly SessionConnectionGroup[],
  projectId: string | null,
): SessionProjectBridgeGroup[] {
  const filteredGroups = filterConnectionGroupsByProject(groups, projectId);
  const summaries = new Map(
    listSessionProjects(filteredGroups).map((project) => [project.id, project]),
  );
  const projects = new Map<string, SessionProjectBridgeGroup>();

  for (const group of filteredGroups) {
    for (const directory of group.directories) {
      const projectIdForDirectory = sessionProjectIdForDirectory(directory);
      const summary = summaries.get(projectIdForDirectory);
      if (!summary) continue;

      let project = projects.get(projectIdForDirectory);
      if (!project) {
        project = { ...summary, bridges: [] };
        projects.set(projectIdForDirectory, project);
      }
      project.bridges.push({ connection: group.connection, directory });
    }
  }

  return [...projects.values()].sort(compareProjects);
}

/** 「全部」视图：剔除被用户隐藏的项目目录；不含任何可见目录的 Bridge 整个隐藏。 */
export function excludeHiddenProjects(
  groups: readonly SessionConnectionGroup[],
  hiddenProjectIds: ReadonlySet<string>,
): SessionConnectionGroup[] {
  if (hiddenProjectIds.size === 0) return [...groups];

  return groups.flatMap((group) => {
    const directories = group.directories.filter(
      (directory) => !hiddenProjectIds.has(sessionProjectIdForDirectory(directory)),
    );
    if (directories.length === 0) return [];

    const visibleSessionIds = new Set(
      directories.flatMap((directory) =>
        directory.sessions.map((session) => session.id),
      ),
    );
    return [
      {
        ...group,
        directories,
        sessions: group.sessions.filter((session) =>
          visibleSessionIds.has(session.id),
        ),
      },
    ];
  });
}

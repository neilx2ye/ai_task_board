import type { AIBridgeDirectoryRow } from "@/lib/types/database";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";
import {
  BRIDGE_KINDS,
  canonicalBridgeKind,
  isUnifiedPlatform,
} from "@/lib/agent-platforms";

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
  /** 稳定分组标识；统一设备连接会按运行时拆成 `connectionId:platform`。 */
  id: string;
  connection: SessionConnectionSummary;
  /** 统一设备连接分组对应的规范运行时类型；单运行时连接为 null。 */
  platform: string | null;
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
  /** 项目内正在执行的任务数（claimed/running）。 */
  runningTaskCount: number;
  /** 项目内已完成但用户尚未查看的任务数。 */
  unviewedCompletedCount: number;
};

export type SessionProjectBridge = {
  groupId: string;
  platform: string | null;
  connection: SessionConnectionSummary;
  directory: SessionDirectoryGroup;
};

/** 项目优先视图：一个项目下对该地址有权限的所有 Bridge。 */
export type SessionProjectBridgeGroup = SessionProjectGroup & {
  bridges: SessionProjectBridge[];
};

const UNASSIGNED_PROJECT_ID = "unassigned";

/** 分组对外展示时使用的运行时平台：拆分出的运行时优先，否则用连接平台。 */
export function groupRuntimePlatform(
  group: Pick<SessionConnectionGroup, "connection" | "platform">,
): string {
  return group.platform ?? group.connection.platform;
}

/**
 * 面向 UI 的连接摘要：把分组里的运行时平台投影到连接平台上，
 * 同时保留真实 connection id，供能力判断与文案展示使用。
 */
export function runtimeConnectionSummary(
  group: Pick<SessionConnectionGroup, "connection" | "platform">,
): SessionConnectionSummary {
  return {
    ...group.connection,
    platform: groupRuntimePlatform(group),
  };
}

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
  const sessionsByKey = new Map<string, SessionListItem[]>();
  const directoriesByKey = new Map<string, AIBridgeDirectoryRow[]>();
  const catalogSessionByKey = new Map<string, SessionListItem>();
  const platformsByConnection = new Map<string, Set<string>>();
  const connectionById = new Map(
    connections.map((connection) => [connection.id, connection]),
  );

  const unifiedKey = (connectionId: string, platform: string) =>
    `${connectionId}:${canonicalBridgeKind(platform)}`;
  const trackPlatform = (connectionId: string, platform: string) => {
    let platforms = platformsByConnection.get(connectionId);
    if (!platforms) {
      platforms = new Set<string>();
      platformsByConnection.set(connectionId, platforms);
    }
    platforms.add(platform);
  };

  for (const session of sessions) {
    if (!connectionById.has(session.connection.id)) {
      connectionById.set(session.connection.id, session.connection);
    }
    const connection = connectionById.get(session.connection.id);
    if (!connection) continue;

    const unified = isUnifiedPlatform(connection.platform);
    const platform = canonicalBridgeKind(session.platform);
    const key = unified
      ? unifiedKey(connection.id, platform)
      : connection.id;
    if (unified) {
      trackPlatform(connection.id, platform);
    }
    if (
      session.connection.model_catalog != null &&
      !catalogSessionByKey.has(key)
    ) {
      catalogSessionByKey.set(key, session);
    }
    appendToIndex(sessionsByKey, key, session);
  }
  for (const directory of directories) {
    const connection = connectionById.get(directory.connection_id);
    const unified = connection
      ? isUnifiedPlatform(connection.platform)
      : false;
    const platform = canonicalBridgeKind(directory.platform);
    const key = unified
      ? unifiedKey(directory.connection_id, platform)
      : directory.connection_id;
    if (unified && connection) {
      trackPlatform(connection.id, platform);
    }
    appendToIndex(directoriesByKey, key, directory);
  }

  const buildGroup = (
    connection: SessionConnectionSummary,
    platform: string | null,
  ): SessionConnectionGroup => {
    const key = platform ? unifiedKey(connection.id, platform) : connection.id;
    const connectionSessions = sessionsByKey.get(key) ?? [];
    const connectionDirectories = buildDirectoryGroups(
      connectionSessions,
      directoriesByKey.get(key) ?? [],
    );
    const visibleSessionIds = new Set(
      connectionDirectories.flatMap((directory) =>
        directory.sessions.map((session) => session.id),
      ),
    );
    const catalogSession = catalogSessionByKey.get(key);
    const inheritsConnectionCatalog =
      catalogSession === undefined &&
      (platform === null ||
        platform === canonicalBridgeKind(connection.platform));

    return {
      id: platform ? key : connection.id,
      connection: {
        ...connection,
        model_catalog:
          catalogSession?.connection.model_catalog ??
          (inheritsConnectionCatalog ? connection.model_catalog : null),
        model_catalog_updated_at:
          catalogSession?.connection.model_catalog_updated_at ??
          (inheritsConnectionCatalog
            ? connection.model_catalog_updated_at
            : null),
      },
      platform,
      sessions: connectionSessions.filter((session) =>
        visibleSessionIds.has(session.id),
      ),
      directories: connectionDirectories,
    };
  };

  const orderedPlatforms = (platforms: ReadonlySet<string> | undefined) => {
    if (!platforms) return [];
    const known = BRIDGE_KINDS.filter((kind) => platforms.has(kind));
    const unknown = [...platforms]
      .filter((kind) => !(BRIDGE_KINDS as readonly string[]).includes(kind))
      .sort((left, right) => left.localeCompare(right));
    return [...known, ...unknown];
  };

  const groups: SessionConnectionGroup[] = [];
  for (const connection of connectionById.values()) {
    if (!isUnifiedPlatform(connection.platform)) {
      groups.push(buildGroup(connection, null));
      continue;
    }
    const platforms = orderedPlatforms(
      platformsByConnection.get(connection.id),
    );
    if (platforms.length === 0) {
      // 统一设备连接尚未上报任何运行时：保持单一设备分组。
      groups.push(buildGroup(connection, null));
      continue;
    }
    for (const platform of platforms) {
      groups.push(buildGroup(connection, platform));
    }
  }
  return groups;
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
      const runningTaskCount = directory.sessions.reduce(
        (count, session) => count + (session.running_task_count ?? 0),
        0,
      );
      const unviewedCompletedCount = directory.sessions.reduce(
        (count, session) =>
          count + (session.unviewed_completed_count ?? 0),
        0,
      );
      const existing = projects.get(id);
      if (existing) {
        existing.sessionCount += directory.sessions.length;
        existing.runningTaskCount += runningTaskCount;
        existing.unviewedCompletedCount += unviewedCompletedCount;
        // 任意一个 Bridge 配置了该目录时，优先展示配置里的目录名。
        if (directory.configured) existing.name = directory.name;
        continue;
      }
      projects.set(id, {
        id,
        name: directory.name,
        workingDirectory: directory.workingDirectory,
        sessionCount: directory.sessions.length,
        runningTaskCount,
        unviewedCompletedCount,
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
      project.bridges.push({
        groupId: group.id,
        platform: group.platform,
        connection: group.connection,
        directory,
      });
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

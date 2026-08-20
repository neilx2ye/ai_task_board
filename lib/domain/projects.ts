import "server-only";

import type { UserWorkspaceContext } from "@/lib/auth/user";
import { bridgeKindDisplayName } from "@/lib/agent-platforms";
import { updateBridgeConfiguration } from "@/lib/domain/bridge-config";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import { migrateProjectPlanningNote } from "@/lib/domain/planning";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  BridgeWorkingDirectory,
  CreateProjectResponse,
  ProjectDispatchResult,
  ProjectDeletionResponse,
} from "@/lib/types/database";
import { bridgeWorkingDirectoriesSchema } from "@/lib/validation/bridge-config";
import type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "@/lib/validation/projects";

type BridgeSettingsSnapshot = {
  platform: string;
  version: number;
  desired_enabled: boolean;
  desired_include_thread_titles: boolean;
  desired_max_threads: number;
  desired_max_concurrent_turns: number;
  desired_sync_history: boolean;
  desired_history_turn_limit: number;
  desired_permission_mode:
    | "safe"
    | "inherit"
    | "danger-full-access"
    | null;
  desired_approval_mode: "decline" | "accept" | "accept-session" | null;
  desired_working_directories: unknown;
  effective_working_directories: unknown;
};

const SETTINGS_SNAPSHOT_COLUMNS =
  "platform, version, desired_enabled, desired_include_thread_titles, desired_max_threads, desired_max_concurrent_turns, desired_sync_history, desired_history_turn_limit, desired_permission_mode, desired_approval_mode, desired_working_directories, effective_working_directories" as const;

function parseDirectoryList(value: unknown): BridgeWorkingDirectory[] | null {
  if (value === null || value === undefined) return null;
  const parsed = bridgeWorkingDirectoriesSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Bridge working-directory configuration is invalid",
    );
  }
  return parsed.data;
}

/** 从项目名派生合法且清单内唯一的 directory_key。 */
export function deriveDirectoryKey(
  name: string,
  existingKeys: ReadonlySet<string>,
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-._]+$/, "")
    .slice(0, 90);
  const base = slug || "project";
  if (!existingKeys.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingKeys.has(candidate)) return candidate;
  }
}

async function dispatchToConnection(
  context: UserWorkspaceContext,
  connection: { id: string; name: string },
  input: CreateProjectInput,
  idempotencyKey: string,
): Promise<ProjectDispatchResult[]> {
  const admin = createAdminClient();
  const base = { connection_id: connection.id, connection_name: connection.name };
  const { data: rows, error } = await admin
    .from("ai_connection_bridge_settings")
    .select(SETTINGS_SNAPSHOT_COLUMNS)
    .eq("workspace_id", context.workspaceId)
    .eq("connection_id", connection.id);
  if (error) throw mapDatabaseError(error);
  if (!rows?.length) {
    return [
      { ...base, status: "skipped", reason: "Bridge 配置尚未初始化" },
    ];
  }

  const results: ProjectDispatchResult[] = [];
  for (const row of rows) {
    let snapshot = row as unknown as BridgeSettingsSnapshot;
    const label =
      rows.length > 1
        ? `${connection.name}（${bridgeKindDisplayName(snapshot.platform)}）`
        : connection.name;
    const resultBase = {
      connection_id: connection.id,
      connection_name: label,
    };
    // 版本冲突时重取最新配置重试一次。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        const refreshed = await admin
          .from("ai_connection_bridge_settings")
          .select(SETTINGS_SNAPSHOT_COLUMNS)
          .eq("workspace_id", context.workspaceId)
          .eq("connection_id", connection.id)
          .eq("platform", snapshot.platform)
          .maybeSingle();
        if (refreshed.error) throw mapDatabaseError(refreshed.error);
        if (!refreshed.data) {
          results.push({
            ...resultBase,
            status: "failed",
            reason: "Bridge 配置不可用",
          });
          break;
        }
        snapshot = refreshed.data as unknown as BridgeSettingsSnapshot;
      }
      let baseline: BridgeWorkingDirectory[] | null;
      try {
        baseline =
          parseDirectoryList(snapshot.desired_working_directories) ??
          parseDirectoryList(snapshot.effective_working_directories);
      } catch {
        results.push({
          ...resultBase,
          status: "failed",
          reason: "现有目录配置数据无效",
        });
        break;
      }
      if (!baseline) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason: "Bridge 尚未上报目录清单，请先在设备上启动 Bridge",
        });
        break;
      }
      if (
        baseline.some(
          (directory) =>
            directory.working_directory === input.working_directory,
        )
      ) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason: "该项目已在目录清单中",
        });
        break;
      }
      if (baseline.length >= 100) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason: "目录清单已达上限",
        });
        break;
      }

      const entry: BridgeWorkingDirectory = {
        directory_key: deriveDirectoryKey(
          input.name,
          new Set(baseline.map((directory) => directory.directory_key)),
        ),
        name: input.name,
        working_directory: input.working_directory,
        create_if_missing: true,
      };

      try {
        await updateBridgeConfiguration(
          context,
          connection.id,
          snapshot.platform,
          {
            expected_version: snapshot.version,
            enabled: snapshot.desired_enabled,
            include_thread_titles: snapshot.desired_include_thread_titles,
            max_threads: snapshot.desired_max_threads,
            max_concurrent_turns: snapshot.desired_max_concurrent_turns,
            sync_history: snapshot.desired_sync_history,
            history_turn_limit: snapshot.desired_history_turn_limit,
            permission_mode: snapshot.desired_permission_mode,
            approval_mode: snapshot.desired_approval_mode,
            working_directories: [...baseline, entry],
          },
          // 批次内每个 Bridge 平台使用独立的派生幂等键；冲突重试换新键。
          `${idempotencyKey.slice(0, 110)}:${connection.id}:${snapshot.platform}${
            attempt === 0 ? "" : ":retry"
          }`,
        );
        results.push({ ...resultBase, status: "submitted" });
        break;
      } catch (updateError) {
        if (
          updateError instanceof AppError &&
          updateError.code === "VERSION_CONFLICT" &&
          attempt === 0
        ) {
          continue;
        }
        results.push({
          ...resultBase,
          status: "failed",
          reason:
            updateError instanceof AppError
              ? updateError.message
              : "下发失败，请稍后重试",
        });
        break;
      }
    }
  }
  return results;
}

/**
 * Web 创建项目：把新目录（带 create_if_missing 授权）追加到目标设备上
 * 每个 Bridge 的托管目录清单，Bridge 应用后会在本机创建并纳入清单同步。
 */
export async function createProjectOnBridges(
  context: UserWorkspaceContext,
  input: CreateProjectInput,
  idempotencyKey: string,
): Promise<CreateProjectResponse> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_connections")
    .select("id, name")
    .eq("workspace_id", context.workspaceId)
    .is("revoked_at", null)
    .in("id", [...input.connection_ids]);
  if (error) throw mapDatabaseError(error);

  const connections = new Map(
    (data ?? []).map((connection) => [connection.id, connection]),
  );
  const results: ProjectDispatchResult[] = [];
  for (const connectionId of input.connection_ids) {
    const connection = connections.get(connectionId);
    if (!connection) {
      results.push({
        connection_id: connectionId,
        connection_name: connectionId,
        status: "failed",
        reason: "连接不存在或已撤销",
      });
      continue;
    }
    results.push(
      ...(await dispatchToConnection(
        context,
        connection,
        input,
        idempotencyKey,
      )),
    );
  }
  return { results };
}

/**
 * Web 修改项目：把名称与绝对路径同步到所有包含该路径的 Bridge 目录清单。
 * directory_key 保持稳定，因此 Session 与 Thread 仍挂在同一项目下；
 * 路径变化时同时迁移按路径共享的规划笔记。
 */
async function dispatchProjectUpdate(
  context: UserWorkspaceContext,
  connection: { id: string; name: string },
  input: UpdateProjectInput,
  idempotencyKey: string,
): Promise<ProjectDispatchResult[]> {
  const admin = createAdminClient();
  const base = { connection_id: connection.id, connection_name: connection.name };
  const { data: rows, error } = await admin
    .from("ai_connection_bridge_settings")
    .select(SETTINGS_SNAPSHOT_COLUMNS)
    .eq("workspace_id", context.workspaceId)
    .eq("connection_id", connection.id);
  if (error) throw mapDatabaseError(error);
  if (!rows?.length) {
    return [
      { ...base, status: "skipped", reason: "Bridge 配置尚未初始化" },
    ];
  }

  const results: ProjectDispatchResult[] = [];
  for (const row of rows) {
    let snapshot = row as unknown as BridgeSettingsSnapshot;
    const label =
      rows.length > 1
        ? `${connection.name}（${bridgeKindDisplayName(snapshot.platform)}）`
        : connection.name;
    const resultBase = {
      connection_id: connection.id,
      connection_name: label,
    };
    // 版本冲突时重取最新配置重试一次。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        const refreshed = await admin
          .from("ai_connection_bridge_settings")
          .select(SETTINGS_SNAPSHOT_COLUMNS)
          .eq("workspace_id", context.workspaceId)
          .eq("connection_id", connection.id)
          .eq("platform", snapshot.platform)
          .maybeSingle();
        if (refreshed.error) throw mapDatabaseError(refreshed.error);
        if (!refreshed.data) {
          results.push({
            ...resultBase,
            status: "failed",
            reason: "Bridge 配置不可用",
          });
          break;
        }
        snapshot = refreshed.data as unknown as BridgeSettingsSnapshot;
      }

      let baseline: BridgeWorkingDirectory[] | null;
      try {
        baseline =
          parseDirectoryList(snapshot.desired_working_directories) ??
          parseDirectoryList(snapshot.effective_working_directories);
      } catch {
        results.push({
          ...resultBase,
          status: "failed",
          reason: "现有目录配置数据无效",
        });
        break;
      }
      if (!baseline) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason: "Bridge 尚未上报目录清单，请先在设备上启动 Bridge",
        });
        break;
      }
      if (
        !baseline.some(
          (directory) =>
            directory.working_directory === input.working_directory,
        )
      ) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason: "该项目不在该 Bridge 的目录清单中",
        });
        break;
      }
      if (
        input.new_working_directory !== input.working_directory &&
        baseline.some(
          (directory) =>
            directory.working_directory === input.new_working_directory,
        )
      ) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason: "目标路径已在目录清单中",
        });
        break;
      }

      const workingDirectories = baseline.map((directory) =>
        directory.working_directory === input.working_directory
          ? {
              ...directory,
              name: input.name,
              working_directory: input.new_working_directory,
            }
          : directory,
      );

      try {
        await updateBridgeConfiguration(
          context,
          connection.id,
          snapshot.platform,
          {
            expected_version: snapshot.version,
            enabled: snapshot.desired_enabled,
            include_thread_titles: snapshot.desired_include_thread_titles,
            max_threads: snapshot.desired_max_threads,
            max_concurrent_turns: snapshot.desired_max_concurrent_turns,
            sync_history: snapshot.desired_sync_history,
            history_turn_limit: snapshot.desired_history_turn_limit,
            permission_mode: snapshot.desired_permission_mode,
            approval_mode: snapshot.desired_approval_mode,
            working_directories: workingDirectories,
          },
          // 批次内每个 Bridge 平台使用独立的派生幂等键；冲突重试换新键。
          `${idempotencyKey.slice(0, 110)}:${connection.id}:${snapshot.platform}${
            attempt === 0 ? "" : ":retry"
          }`,
        );
        results.push({ ...resultBase, status: "submitted" });
        break;
      } catch (updateError) {
        if (
          updateError instanceof AppError &&
          updateError.code === "VERSION_CONFLICT" &&
          attempt === 0
        ) {
          continue;
        }
        results.push({
          ...resultBase,
          status: "failed",
          reason:
            updateError instanceof AppError
              ? updateError.message
              : "下发失败，请稍后重试",
        });
        break;
      }
    }
  }
  return results;
}

export async function updateProjectOnBridges(
  context: UserWorkspaceContext,
  input: UpdateProjectInput,
  idempotencyKey: string,
): Promise<CreateProjectResponse> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_connections")
    .select("id, name")
    .eq("workspace_id", context.workspaceId)
    .is("revoked_at", null);
  if (error) throw mapDatabaseError(error);

  const results: ProjectDispatchResult[] = [];
  for (const connection of data ?? []) {
    results.push(
      ...(await dispatchProjectUpdate(
        context,
        connection,
        input,
        idempotencyKey,
      )),
    );
  }

  // 只要有一个 Bridge 接受了路径变更，规划笔记就随项目新路径迁移；
  // 设备后续若拒绝该路径，可在 Bridge 设置中看到错误并改回。
  if (
    input.new_working_directory !== input.working_directory &&
    results.some((result) => result.status === "submitted")
  ) {
    await migrateProjectPlanningNote(
      context,
      input.working_directory,
      input.new_working_directory,
    );
  }
  return { results };
}

/**
 * 把项目从看板数据库中移除：删除目录清单记录，并把引用它的 Session 从项目
 * 摘除后隐藏。这里只删 Board 侧的目录记录，不会下发任何删除本机文件或
 * Thread 的命令；Session 审计数据仍保留，设备文件保持原样。
 */
async function removeProjectDatabaseRecords(
  context: UserWorkspaceContext,
  workingDirectory: string,
): Promise<Pick<ProjectDeletionResponse, "deleted_directory_rows" | "detached_sessions">> {
  const admin = createAdminClient();
  const { data: directories, error: directoriesError } = await admin
    .from("ai_bridge_directories")
    .select("connection_id, platform, directory_key")
    .eq("workspace_id", context.workspaceId)
    .eq("working_directory", workingDirectory);
  if (directoriesError) throw mapDatabaseError(directoriesError);

  // 旧 Bridge 的 Session 可能只有 working_directory、没有 directory_key。
  // 先处理这类记录，再按 directory_key 处理，避免重复计数。
  let detachedSessions = 0;
  const { data: legacySessions, error: legacySessionsError } = await admin
    .from("ai_sessions")
    .update({
      bridge_directory_key: null,
      inventory_active: false,
      status: "offline" as const,
    })
    .eq("workspace_id", context.workspaceId)
    .eq("working_directory", workingDirectory)
    .is("bridge_directory_key", null)
    .select("id");
  if (legacySessionsError) throw mapDatabaseError(legacySessionsError);
  detachedSessions += (legacySessions ?? []).length;

  for (const directory of directories ?? []) {
    const { data: sessions, error: sessionsError } = await admin
      .from("ai_sessions")
      .update({
        bridge_directory_key: null,
        inventory_active: false,
        status: "offline" as const,
      })
      .eq("workspace_id", context.workspaceId)
      .eq("connection_id", directory.connection_id)
      .eq("platform", directory.platform)
      .eq("bridge_directory_key", directory.directory_key)
      .select("id");
    if (sessionsError) throw mapDatabaseError(sessionsError);
    detachedSessions += (sessions ?? []).length;

    const { error: commandsError } = await admin
      .from("ai_thread_commands")
      .update({ directory_key: null })
      .eq("workspace_id", context.workspaceId)
      .eq("connection_id", directory.connection_id)
      .eq("platform", directory.platform)
      .eq("directory_key", directory.directory_key);
    if (commandsError) throw mapDatabaseError(commandsError);
  }

  const { data: deleted, error: deletedError } = await admin
    .from("ai_bridge_directories")
    .delete()
    .eq("workspace_id", context.workspaceId)
    .eq("working_directory", workingDirectory)
    .select("connection_id, platform, directory_key");
  if (deletedError) throw mapDatabaseError(deletedError);

  return {
    deleted_directory_rows: (deleted ?? []).length,
    detached_sessions: detachedSessions,
  };
}

/**
 * 把项目从每个 Bridge 的托管目录清单中移除。设备只会停止管理该路径，
 * 不会删除本机目录或其中的文件。仅剩这一个目录时，期望清单回退为 null，
 * 让设备恢复启动配置。
 */
async function dispatchProjectDelete(
  context: UserWorkspaceContext,
  connection: { id: string; name: string },
  input: DeleteProjectInput,
  idempotencyKey: string,
): Promise<ProjectDispatchResult[]> {
  const admin = createAdminClient();
  const base = {
    connection_id: connection.id,
    connection_name: connection.name,
  };
  const { data: rows, error } = await admin
    .from("ai_connection_bridge_settings")
    .select(SETTINGS_SNAPSHOT_COLUMNS)
    .eq("workspace_id", context.workspaceId)
    .eq("connection_id", connection.id);
  if (error) throw mapDatabaseError(error);
  if (!rows?.length) {
    return [
      { ...base, status: "skipped", reason: "Bridge 配置尚未初始化" },
    ];
  }

  const results: ProjectDispatchResult[] = [];
  for (const row of rows) {
    let snapshot = row as unknown as BridgeSettingsSnapshot;
    const label =
      rows.length > 1
        ? `${connection.name}（${bridgeKindDisplayName(snapshot.platform)}）`
        : connection.name;
    const resultBase = {
      connection_id: connection.id,
      connection_name: label,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        const refreshed = await admin
          .from("ai_connection_bridge_settings")
          .select(SETTINGS_SNAPSHOT_COLUMNS)
          .eq("workspace_id", context.workspaceId)
          .eq("connection_id", connection.id)
          .eq("platform", snapshot.platform)
          .maybeSingle();
        if (refreshed.error) throw mapDatabaseError(refreshed.error);
        if (!refreshed.data) {
          results.push({
            ...resultBase,
            status: "failed",
            reason: "Bridge 配置不可用",
          });
          break;
        }
        snapshot = refreshed.data as unknown as BridgeSettingsSnapshot;
      }

      let desired: BridgeWorkingDirectory[] | null;
      let effective: BridgeWorkingDirectory[] | null;
      try {
        desired = parseDirectoryList(snapshot.desired_working_directories);
        effective = parseDirectoryList(snapshot.effective_working_directories);
      } catch {
        results.push({
          ...resultBase,
          status: "failed",
          reason: "现有目录配置数据无效",
        });
        break;
      }

      const desiredHasProject =
        desired?.some(
          (directory) =>
            directory.working_directory === input.working_directory,
        ) ?? false;
      const effectiveHasProject =
        effective?.some(
          (directory) =>
            directory.working_directory === input.working_directory,
        ) ?? false;
      if (!desiredHasProject && !effectiveHasProject) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason: "该项目不在该 Bridge 的目录清单中",
        });
        break;
      }

      const source = desired ?? effective;
      const remaining =
        source?.filter(
          (directory) =>
            directory.working_directory !== input.working_directory,
        ) ?? [];
      if (remaining.length === source?.length) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason: "该 Bridge 已停止托管这个项目",
        });
        break;
      }

      // 清单不能为空：删除最后一个项目时回退到设备启动配置。
      const nextDirectories: BridgeWorkingDirectory[] | null =
        remaining.length > 0 ? remaining : null;
      if (desired === null && nextDirectories === null) {
        results.push({
          ...resultBase,
          status: "skipped",
          reason:
            "该项目是最后一个托管目录；已回退设备启动配置，若启动配置仍包含该路径，设备同步后可能重新出现",
        });
        break;
      }

      try {
        await updateBridgeConfiguration(
          context,
          connection.id,
          snapshot.platform,
          {
            expected_version: snapshot.version,
            enabled: snapshot.desired_enabled,
            include_thread_titles: snapshot.desired_include_thread_titles,
            max_threads: snapshot.desired_max_threads,
            max_concurrent_turns: snapshot.desired_max_concurrent_turns,
            sync_history: snapshot.desired_sync_history,
            history_turn_limit: snapshot.desired_history_turn_limit,
            permission_mode: snapshot.desired_permission_mode,
            approval_mode: snapshot.desired_approval_mode,
            working_directories: nextDirectories,
          },
          `${idempotencyKey.slice(0, 110)}:${connection.id}:${
            snapshot.platform
          }:delete${attempt === 0 ? "" : ":retry"}`,
        );
        results.push({ ...resultBase, status: "submitted" });
        break;
      } catch (updateError) {
        if (
          updateError instanceof AppError &&
          updateError.code === "VERSION_CONFLICT" &&
          attempt === 0
        ) {
          continue;
        }
        results.push({
          ...resultBase,
          status: "failed",
          reason:
            updateError instanceof AppError
              ? updateError.message
              : "下发失败，请稍后重试",
        });
        break;
      }
    }
  }
  return results;
}

/**
 * Web 删除项目：删除 Board 数据库中的目录记录，并停止各 Bridge 对该路径的
 * 托管。整个过程不会创建删除本机文件/目录的命令。
 */
export async function deleteProjectOnBridges(
  context: UserWorkspaceContext,
  input: DeleteProjectInput,
  idempotencyKey: string,
): Promise<ProjectDeletionResponse> {
  const removal = await removeProjectDatabaseRecords(
    context,
    input.working_directory,
  );
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_connections")
    .select("id, name")
    .eq("workspace_id", context.workspaceId)
    .is("revoked_at", null);
  if (error) throw mapDatabaseError(error);

  const results: ProjectDispatchResult[] = [];
  for (const connection of data ?? []) {
    results.push(
      ...(await dispatchProjectDelete(
        context,
        connection,
        input,
        idempotencyKey,
      )),
    );
  }
  return { ...removal, results };
}

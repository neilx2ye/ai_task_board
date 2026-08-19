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
} from "@/lib/types/database";
import { bridgeWorkingDirectoriesSchema } from "@/lib/validation/bridge-config";
import type {
  CreateProjectInput,
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
  desired_working_directories: unknown;
  effective_working_directories: unknown;
};

const SETTINGS_SNAPSHOT_COLUMNS =
  "platform, version, desired_enabled, desired_include_thread_titles, desired_max_threads, desired_max_concurrent_turns, desired_sync_history, desired_history_turn_limit, desired_working_directories, effective_working_directories" as const;

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

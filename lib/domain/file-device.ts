import "server-only";

import { randomUUID } from "node:crypto";

import type { UserWorkspaceContext } from "@/lib/auth/user";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import { pathExistsWithinRoots } from "@/lib/domain/file-explorer";
import { collectRangePages } from "@/lib/domain/postgrest-pagination";
import { callDomainRpc } from "@/lib/domain/rpc";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  AIAuthContext,
  FileDeviceCommand,
  FileExplorerBridgeProject,
  FileExplorerDirectory,
  FilePreview,
} from "@/lib/types/domain";
import type {
  Json,
  AIFileCommandRow,
} from "@/lib/types/database";
import type {
  ClaimFileCommandInput,
  CompleteFileCommandInput,
} from "@/lib/validation/ai";
import type { CreateDeviceFileCommandInput } from "@/lib/validation/user";

const MAX_BRIDGE_PROJECTS = 500;

type ConnectionSummary = {
  id: string;
  name: string;
  platform: string;
  bridgeVersion: string | null;
};

function projectIdForDirectory(workingDirectory: string): string {
  return `path:${workingDirectory}`;
}

/** 目标路径必须位于该连接已上报的某个工作目录内（字符串边界包含判断）。 */
function pathWithinWorkingDirectory(
  workingDirectory: string,
  targetPath: string,
): boolean {
  const parent = workingDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = targetPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return target === parent || target.startsWith(`${parent}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCommandPayload(value: Json | null): FileDeviceCommand["result"] {
  if (!isRecord(value)) return null;
  // Bridge 回传的目录列表与预览结果直接复用文件浏览页的类型形状；
  // 这里只做宽松的运行时校验，UI 端有更严格的展示容错。
  if (
    typeof value.path === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.entries)
  ) {
    return value as unknown as FileExplorerDirectory;
  }
  if (typeof value.kind === "string" && typeof value.name === "string") {
    return value as unknown as FilePreview;
  }
  return null;
}

type CommandRowShape = Pick<
  AIFileCommandRow,
  | "id"
  | "workspace_id"
  | "connection_id"
  | "action"
  | "path"
  | "status"
  | "result"
  | "error"
  | "created_at"
  | "completed_at"
>;

function mapCommandRow(row: CommandRowShape): FileDeviceCommand {
  const status =
    row.status === "failed"
      ? "failed"
      : row.status === "running"
        ? "running"
        : row.status === "succeeded"
          ? "succeeded"
          : "queued";
  return {
    id: row.id,
    connectionId: row.connection_id,
    action: row.action === "read" ? "read" : "list",
    path: row.path,
    status,
    result: parseCommandPayload(row.result),
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

async function fetchCommandRow(commandId: string) {
  const { data, error } = await createAdminClient()
    .from("ai_file_commands")
    .select(
      "id, workspace_id, connection_id, action, path, status, result, error, created_at, completed_at",
    )
    .eq("id", commandId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  return data;
}

/**
 * 与页面顶部项目 Tab 同源的项目列表：按 working directory 合并每个连接
 * 上报的目录，并标注该路径是否可由 Board 服务本机直接读取。
 */
export async function listFileExplorerBridgeProjects(
  context: UserWorkspaceContext,
): Promise<FileExplorerBridgeProject[]> {
  const admin = createAdminClient();
  const directories = await collectRangePages(async (from, to) => {
    const { data, error } = await admin
      .from("ai_bridge_directories")
      .select("directory_key, name, working_directory, inventory_active, connection_id")
      .eq("workspace_id", context.workspaceId)
      .order("connection_id")
      .order("inventory_active", { ascending: false })
      .order("name")
      .order("directory_key")
      .range(from, to);
    if (error) throw mapDatabaseError(error);
    return data ?? [];
  });

  const connections = await collectRangePages(async (from, to) => {
    const { data, error } = await admin
      .from("ai_connections")
      .select("id, name, platform, bridge_version, revoked_at")
      .eq("workspace_id", context.workspaceId)
      .order("id")
      .range(from, to);
    if (error) throw mapDatabaseError(error);
    return data ?? [];
  });
  const connectionById = new Map<string, ConnectionSummary>();
  for (const connection of connections) {
    if (connection.revoked_at) continue;
    connectionById.set(connection.id, {
      id: connection.id,
      name: connection.name,
      platform: connection.platform,
      bridgeVersion: connection.bridge_version,
    });
  }

  type ProjectAccumulator = {
    id: string;
    name: string;
    workingDirectory: string;
    connections: Map<string, ConnectionSummary>;
  };
  const projects = new Map<string, ProjectAccumulator>();

  for (const directory of directories) {
    if (!directory.inventory_active) continue;
    const connection = connectionById.get(directory.connection_id);
    if (!connection) continue;
    const id = projectIdForDirectory(directory.working_directory);
    let project = projects.get(id);
    if (!project) {
      project = {
        id,
        name: directory.name,
        workingDirectory: directory.working_directory,
        connections: new Map(),
      };
      projects.set(id, project);
    }
    project.connections.set(connection.id, connection);
    if (projects.size > MAX_BRIDGE_PROJECTS) break;
  }

  const result: FileExplorerBridgeProject[] = [];
  for (const project of projects.values()) {
    result.push({
      id: project.id,
      name: project.name,
      workingDirectory: project.workingDirectory,
      connections: [...project.connections.values()]
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
        .map((connection) => ({
          id: connection.id,
          name: connection.name,
          platform: connection.platform,
          bridgeVersion: connection.bridgeVersion,
        })),
      serverAccessible: await pathExistsWithinRoots(project.workingDirectory),
    });
  }

  return result.sort(
    (left, right) =>
      left.name.localeCompare(right.name, "zh-CN") ||
      left.workingDirectory.localeCompare(right.workingDirectory),
  );
}

/** 校验命令目标位于该连接的工作目录清单内，并持久化一条设备文件命令。 */
export async function enqueueFileDeviceCommand(
  context: UserWorkspaceContext,
  input: CreateDeviceFileCommandInput,
): Promise<FileDeviceCommand> {
  const admin = createAdminClient();
  const { data: directories, error } = await admin
    .from("ai_bridge_directories")
    .select("directory_key, name, working_directory, inventory_active")
    .eq("workspace_id", context.workspaceId)
    .eq("connection_id", input.connection_id)
    .eq("inventory_active", true);
  if (error) throw mapDatabaseError(error);

  const managedDirectory = (directories ?? []).find((directory) =>
    pathWithinWorkingDirectory(directory.working_directory, input.path),
  );
  if (!managedDirectory) {
    throw new AppError(
      "INVALID_REQUEST",
      "该路径不在所选连接的受管工作目录内",
    );
  }

  const response = await callDomainRpc("enqueue_ai_file_command", {
    p_workspace_id: context.workspaceId,
    p_user_id: context.userId,
    p_command_id: randomUUID(),
    p_connection_id: input.connection_id,
    p_action: input.action,
    p_path: input.path,
  });
  const command = response.command;
  if (!command) {
    throw new AppError("INTERNAL_ERROR", "设备文件命令创建失败");
  }
  return mapCommandRow(command);
}

/** 仅限 Workspace Owner 查询自己工作区内的一条设备文件命令结果。 */
export async function getFileDeviceCommand(
  context: UserWorkspaceContext,
  commandId: string,
): Promise<FileDeviceCommand> {
  const row = await fetchCommandRow(commandId);
  if (!row || row.workspace_id !== context.workspaceId) {
    throw new AppError("PATH_NOT_FOUND", "设备文件命令不存在");
  }
  return mapCommandRow(row);
}

export function claimFileDeviceCommand(
  auth: AIAuthContext,
  input: ClaimFileCommandInput,
) {
  return callDomainRpc("claim_ai_file_command", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_runtime_instance_id: input.runtime_instance_id,
    p_lease_seconds: input.lease_seconds,
  });
}

export function completeFileDeviceCommand(
  auth: AIAuthContext,
  commandId: string,
  input: CompleteFileCommandInput,
) {
  return callDomainRpc("complete_ai_file_command", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_runtime_instance_id: input.runtime_instance_id,
    p_command_id: commandId,
    p_succeeded: input.succeeded,
    p_result: (input.result as Json | null) ?? null,
    p_error: input.error ?? null,
  });
}

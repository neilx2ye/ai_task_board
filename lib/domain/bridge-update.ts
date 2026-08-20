import "server-only";

import type { UserWorkspaceContext } from "@/lib/auth/user";
import {
  canonicalBridgeKind,
  isUnifiedPlatform,
} from "@/lib/agent-platforms";
import { bridgeReleaseExists } from "@/lib/bridge-release";
import {
  compareBridgeVersions,
  isBridgeVersionString,
} from "@/lib/bridge-version";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UpdateBridgeVersionInput } from "@/lib/validation/bridge-config";

export type BridgeUpdateTargetResponse = {
  desired_bridge_version: string | null;
};

/**
 * Owner 设置/取消某个 Bridge 的自更新目标版本。Bridge 在配置交换响应里
 * 读到该版本后，会从 npm 下载并重启到该版本（远程升级默认开启，前台非
 * systemd 进程除外）。
 */
export async function setBridgeUpdateTarget(
  context: UserWorkspaceContext,
  connectionId: string,
  input: UpdateBridgeVersionInput,
): Promise<BridgeUpdateTargetResponse> {
  if (context.role !== "owner") {
    throw new AppError("FORBIDDEN", "Workspace owner access is required");
  }
  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("ai_connections")
    .select("id, platform, bridge_version")
    .eq("workspace_id", context.workspaceId)
    .eq("id", connectionId)
    .is("revoked_at", null)
    .maybeSingle();
  if (connectionError) throw mapDatabaseError(connectionError);
  if (!connection) {
    throw new AppError("FORBIDDEN", "The Bridge connection is not accessible");
  }

  const platform = canonicalBridgeKind(input.platform ?? connection.platform);
  const settings = await admin
    .from("ai_connection_bridge_settings")
    .select("platform, bridge_version, desired_bridge_version")
    .eq("workspace_id", context.workspaceId)
    .eq("connection_id", connectionId)
    .eq("platform", platform)
    .maybeSingle();
  let perPlatformSchema = true;
  if (settings.error) {
    if (isMissingPlatformColumn(settings.error)) {
      perPlatformSchema = false;
    } else if (!isMissingBridgeVersionColumn(settings.error)) {
      throw mapDatabaseError(settings.error);
    }
    // 滚动部署：平台/版本维度尚未落地时回退到连接级版本。
  }
  const reportedVersion = !perPlatformSchema
    ? isUnifiedPlatform(connection.platform)
      ? null
      : connection.bridge_version
    : isUnifiedPlatform(connection.platform)
      ? (settings.data?.bridge_version ?? null)
      : (settings.data?.bridge_version ?? connection.bridge_version);

  const target = input.target_version;
  if (target === null) {
    let clearQuery = admin
      .from("ai_connection_bridge_settings")
      .update({ desired_bridge_version: null })
      .eq("workspace_id", context.workspaceId)
      .eq("connection_id", connectionId);
    if (perPlatformSchema) {
      clearQuery = clearQuery.eq("platform", platform);
    }
    const { error } = await clearQuery;
    if (error) throw mapDatabaseError(error);
    return { desired_bridge_version: null };
  }

  if (!isBridgeVersionString(target)) {
    throw new AppError("INVALID_REQUEST", "目标版本必须是 x.y.z 形式");
  }
  if (reportedVersion === null) {
    throw new AppError(
      "INVALID_REQUEST",
      "该 Bridge 运行时尚未上报版本，无法下发升级目标",
    );
  }
  const comparison = compareBridgeVersions(target, reportedVersion);
  if (comparison === null || comparison <= 0) {
    throw new AppError(
      "INVALID_REQUEST",
      "目标版本必须大于该 Bridge 当前上报的版本",
    );
  }
  if (!(await bridgeReleaseExists(target))) {
    throw new AppError(
      "INVALID_REQUEST",
      "无法确认该版本已发布到 npm，请检查版本号或稍后重试",
    );
  }

  const { error } = perPlatformSchema
    ? await admin
        .from("ai_connection_bridge_settings")
        .upsert(
          {
            workspace_id: context.workspaceId,
            connection_id: connectionId,
            platform,
            desired_bridge_version: target,
          },
          { onConflict: "connection_id,platform" },
        )
    : await admin
        .from("ai_connection_bridge_settings")
        .update({ desired_bridge_version: target })
        .eq("workspace_id", context.workspaceId)
        .eq("connection_id", connectionId);
  if (error) throw mapDatabaseError(error);
  return { desired_bridge_version: target };
}

function isMissingPlatformColumn(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): boolean {
  if (
    error.code !== "PGRST204" &&
    error.code !== "42703" &&
    error.code !== "42P01"
  ) {
    return false;
  }
  return [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ")
    .includes("platform");
}

function isMissingBridgeVersionColumn(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): boolean {
  if (
    error.code !== "PGRST204" &&
    error.code !== "42703" &&
    error.code !== "42P01"
  ) {
    return false;
  }
  const source = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ");
  return (
    source.includes("bridge_version") &&
    !source.includes("desired_bridge_version")
  );
}

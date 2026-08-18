import "server-only";

import type { UserWorkspaceContext } from "@/lib/auth/user";
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
    .select("id, bridge_version")
    .eq("workspace_id", context.workspaceId)
    .eq("id", connectionId)
    .is("revoked_at", null)
    .maybeSingle();
  if (connectionError) throw mapDatabaseError(connectionError);
  if (!connection) {
    throw new AppError("FORBIDDEN", "The Bridge connection is not accessible");
  }

  const target = input.target_version;
  if (target === null) {
    const { error } = await admin
      .from("ai_connection_bridge_settings")
      .update({ desired_bridge_version: null })
      .eq("workspace_id", context.workspaceId)
      .eq("connection_id", connectionId);
    if (error) throw mapDatabaseError(error);
    return { desired_bridge_version: null };
  }

  if (!isBridgeVersionString(target)) {
    throw new AppError("INVALID_REQUEST", "目标版本必须是 x.y.z 形式");
  }
  const current = connection.bridge_version;
  const comparison = compareBridgeVersions(target, current);
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

  const { error } = await admin
    .from("ai_connection_bridge_settings")
    .update({ desired_bridge_version: target })
    .eq("workspace_id", context.workspaceId)
    .eq("connection_id", connectionId);
  if (error) throw mapDatabaseError(error);
  return { desired_bridge_version: target };
}

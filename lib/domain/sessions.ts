import "server-only";

import { hashRequest } from "@/lib/auth/ai-token";
import { canonicalBridgeKind } from "@/lib/agent-platforms";
import { compareBridgeVersions } from "@/lib/bridge-version";
import { mapDatabaseError } from "@/lib/domain/errors";
import { callDomainRpc } from "@/lib/domain/rpc";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/types/database";
import type { AIAuthContext, AISessionContext } from "@/lib/types/domain";
import type {
  RegisterSessionInput,
  SyncSessionsInput,
} from "@/lib/validation/ai";

export async function registerSession(
  auth: AIAuthContext,
  input: RegisterSessionInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("register_ai_session", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_name: input.name,
    p_platform: input.platform,
    p_model: input.model ?? null,
    p_external_conversation_ref: input.external_conversation_ref ?? null,
    p_capabilities: input.capabilities,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("register_ai_session", input),
  });
}

export async function syncSessions(
  auth: AIAuthContext,
  input: SyncSessionsInput,
  idempotencyKey: string,
): Promise<unknown> {
  const admin = createAdminClient();
  const parameters = {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_bridge_version: input.bridge_version,
    p_platform: input.platform ?? auth.platform,
    p_directories: input.directories
      ? (JSON.parse(JSON.stringify(input.directories)) as Json)
      : null,
    // Zod defaults normalize every thread, while this boundary also removes
    // optional `undefined` keys before handing the value to supabase-js.
    p_threads: JSON.parse(JSON.stringify(input.threads)) as Json,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("sync_ai_sessions_with_directories", input),
  };
  const { data, error } = await admin.rpc(
    "sync_ai_sessions_with_directories",
    parameters,
  );
  if (!error) {
    const platform = canonicalBridgeKind(input.platform ?? auth.platform);
    await persistModelCatalog(admin, auth, platform, input);
    await persistConnectionQuota(admin, auth, platform, input);
    await persistDeviceIdentity(admin, auth, platform, input);
    await clearSatisfiedBridgeUpdate(
      admin,
      auth,
      platform,
      input.bridge_version,
    );
    return data;
  }
  if (!isMissingDirectorySyncFunction(error)) throw mapDatabaseError(error);

  // Rolling-deployment compatibility: a newly upgraded Bridge always reports
  // its directory allowlist, while the database migration may land shortly
  // after the Web release. The legacy RPC still preserves each Session cwd;
  // only directory keys are omitted until the migration becomes available.
  const legacyThreads = input.threads.map((thread) => {
    const legacyThread = { ...thread };
    delete legacyThread.directory_key;
    return legacyThread;
  });
  const legacyInput = {
    bridge_version: input.bridge_version,
    threads: legacyThreads,
  };
  const result = await callDomainRpc("sync_ai_sessions", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_bridge_version: input.bridge_version,
    p_threads: JSON.parse(JSON.stringify(legacyThreads)) as Json,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("sync_ai_sessions", legacyInput),
  });
  const platform = canonicalBridgeKind(input.platform ?? auth.platform);
  await persistModelCatalog(admin, auth, platform, input);
  await persistConnectionQuota(admin, auth, platform, input);
  await persistDeviceIdentity(admin, auth, platform, input);
  await clearSatisfiedBridgeUpdate(
    admin,
    auth,
    platform,
    input.bridge_version,
  );
  return result;
}

/**
 * Bridge 自更新完成后，下一次同步会上报满足目标的新版本号，
 * 此时清除期望版本标记；条件更新避免清掉并发的新目标。
 */
async function clearSatisfiedBridgeUpdate(
  admin: ReturnType<typeof createAdminClient>,
  auth: AIAuthContext,
  platform: string,
  reportedVersion: string,
): Promise<void> {
  const { data, error } = await admin
    .from("ai_connection_bridge_settings")
    .select("desired_bridge_version")
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", auth.connectionId)
    .eq("platform", platform)
    .maybeSingle();
  if (error) {
    if (isMissingDeviceSchema(error)) return;
    throw mapDatabaseError(error);
  }
  const desired = (
    data as { desired_bridge_version?: string | null } | null
  )?.desired_bridge_version;
  if (!desired) return;
  const comparison = compareBridgeVersions(reportedVersion, desired);
  if (comparison === null || comparison < 0) return;

  const { error: clearError } = await admin
    .from("ai_connection_bridge_settings")
    .update({ desired_bridge_version: null })
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", auth.connectionId)
    .eq("platform", platform)
    .eq("desired_bridge_version", desired);
  if (clearError && !isMissingDeviceSchema(clearError)) {
    throw mapDatabaseError(clearError);
  }
}

async function persistDeviceIdentity(
  admin: ReturnType<typeof createAdminClient>,
  auth: AIAuthContext,
  platform: string,
  input: SyncSessionsInput,
): Promise<void> {
  // 成对持久化：只上报一个字段时视为未上报，避免违反成对约束。
  if (input.device_id === undefined || input.device_label === undefined) {
    return;
  }
  const { error } = await admin
    .from("ai_connection_bridge_settings")
    .update({
      device_id: input.device_id,
      device_label: input.device_label,
    })
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", auth.connectionId)
    .eq("platform", platform);
  if (!error || isMissingDeviceSchema(error)) return;
  throw mapDatabaseError(error);
}

async function persistModelCatalog(
  admin: ReturnType<typeof createAdminClient>,
  auth: AIAuthContext,
  platform: string,
  input: SyncSessionsInput,
): Promise<void> {
  if (input.model_catalog === undefined) return;
  const { error } = await admin
    .from("ai_connection_bridge_settings")
    .update({
      model_catalog: JSON.parse(JSON.stringify(input.model_catalog)) as Json,
      model_catalog_updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", auth.connectionId)
    .eq("platform", platform);
  if (!error || isMissingModelCatalogSchema(error)) return;
  throw mapDatabaseError(error);
}

async function persistConnectionQuota(
  admin: ReturnType<typeof createAdminClient>,
  auth: AIAuthContext,
  platform: string,
  input: SyncSessionsInput,
): Promise<void> {
  if (input.quota === undefined) return;
  const { error } = await admin
    .from("ai_connection_bridge_settings")
    .update({
      quota: JSON.parse(JSON.stringify(input.quota)) as Json,
      quota_updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", auth.connectionId)
    .eq("platform", platform);
  if (!error || isMissingQuotaSchema(error)) return;
  throw mapDatabaseError(error);
}

function isMissingDirectorySyncFunction(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): boolean {
  if (error.code !== "PGRST202" && error.code !== "42883") return false;
  return [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ")
    .includes("sync_ai_sessions_with_directories");
}

function isMissingModelCatalogSchema(error: {
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
    .includes("model_catalog");
}

function isMissingQuotaSchema(error: {
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
    .includes("quota");
}

function isMissingDeviceSchema(error: {
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
    source.includes("device_id") ||
    source.includes("device_label") ||
    source.includes("desired_bridge_version")
  );
}

export async function heartbeatSession(
  context: AISessionContext,
  input: Record<string, never>,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("heartbeat_ai_session", {
    p_workspace_id: context.workspaceId,
    p_connection_id: context.connectionId,
    p_api_token_hash: context.tokenHash,
    p_session_id: context.sessionId,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("heartbeat_ai_session", input),
  });
}

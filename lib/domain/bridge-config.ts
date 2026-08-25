import "server-only";

import { hashRequest } from "@/lib/auth/ai-token";
import type { UserWorkspaceContext } from "@/lib/auth/user";
import { canonicalBridgeKind } from "@/lib/agent-platforms";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import { callDomainRpc } from "@/lib/domain/rpc";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  AIConnectionBridgeSettingsRow,
  BridgeAppliedConfiguration,
  BridgeConfiguration,
  BridgeConfigurationConstraints,
  BridgeConfigurationResponse,
  BridgeDesiredConfiguration,
  BridgeWorkingDirectory,
  Json,
} from "@/lib/types/database";
import type { AIAuthContext } from "@/lib/types/domain";
import {
  bridgeWorkingDirectoriesSchema,
  type ExchangeBridgeConfigurationInput,
  type UpdateBridgeConfigurationInput,
} from "@/lib/validation/bridge-config";

const BRIDGE_SETTINGS_COLUMNS =
  "connection_id, platform, workspace_id, version, desired_enabled, desired_include_thread_titles, desired_max_threads, desired_max_concurrent_turns, desired_sync_history, desired_history_turn_limit, desired_working_directories, desired_permission_mode, desired_approval_mode, applied_version, effective_enabled, effective_include_thread_titles, effective_max_threads, effective_max_concurrent_turns, effective_sync_history, effective_history_turn_limit, effective_working_directories, effective_permission_mode, effective_approval_mode, constraint_remote_configuration_enabled, constraint_allow_thread_titles, constraint_max_threads, constraint_max_concurrent_turns, constraint_thread_scope, constraint_working_directory, constraint_fixed_thread, constraint_permission_mode, constraint_approval_mode, constraint_allow_history_sync, constraint_max_history_turns, constraint_allow_working_directory_configuration, model_catalog, model_catalog_updated_at, quota, quota_updated_at, device_id, device_label, desired_bridge_version, bridge_version, error, applied_at, active_runtime_instance_id, active_runtime_last_sequence, active_runtime_lease_expires_at, created_at, updated_at" as const;
const LEGACY_BRIDGE_SETTINGS_COLUMNS =
  "connection_id, platform, workspace_id, version, desired_enabled, desired_include_thread_titles, desired_max_threads, desired_max_concurrent_turns, desired_sync_history, desired_history_turn_limit, applied_version, effective_enabled, effective_include_thread_titles, effective_max_threads, effective_max_concurrent_turns, effective_sync_history, effective_history_turn_limit, constraint_remote_configuration_enabled, constraint_allow_thread_titles, constraint_max_threads, constraint_max_concurrent_turns, constraint_thread_scope, constraint_working_directory, constraint_fixed_thread, constraint_permission_mode, constraint_approval_mode, constraint_allow_history_sync, constraint_max_history_turns, error, applied_at, active_runtime_instance_id, active_runtime_last_sequence, active_runtime_lease_expires_at, created_at, updated_at" as const;

type DatabaseErrorLike = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

type LegacyBridgeSettingsRow = Omit<
  AIConnectionBridgeSettingsRow,
  | "desired_working_directories"
  | "effective_working_directories"
  | "constraint_allow_working_directory_configuration"
  | "desired_permission_mode"
  | "desired_approval_mode"
  | "effective_permission_mode"
  | "effective_approval_mode"
  | "model_catalog"
  | "model_catalog_updated_at"
  | "quota"
  | "quota_updated_at"
  | "device_id"
  | "device_label"
  | "desired_bridge_version"
  | "bridge_version"
>;

function isMissingWorkingDirectorySchema(error: DatabaseErrorLike): boolean {
  if (
    error.code !== "PGRST202" &&
    error.code !== "PGRST204" &&
    error.code !== "42703" &&
    error.code !== "42883"
  ) {
    return false;
  }
  const source = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ");
  return [
    "desired_working_directories",
    "effective_working_directories",
    "constraint_allow_working_directory_configuration",
    "desired_permission_mode",
    "desired_approval_mode",
    "effective_permission_mode",
    "effective_approval_mode",
    "model_catalog",
    "p_working_directories",
    "p_permission_mode",
    "p_approval_mode",
    "device_id",
    "device_label",
    "desired_bridge_version",
    "bridge_version",
  ].some((field) => source.includes(field));
}

function withWorkingDirectoryDefaults(
  row: LegacyBridgeSettingsRow,
): AIConnectionBridgeSettingsRow {
  return {
    ...row,
    platform: row.platform ?? "codex",
    desired_working_directories: null,
    effective_working_directories: null,
    constraint_allow_working_directory_configuration: false,
    desired_permission_mode: null,
    desired_approval_mode: null,
    effective_permission_mode: null,
    effective_approval_mode: null,
    model_catalog: null,
    model_catalog_updated_at: null,
    quota: null,
    quota_updated_at: null,
    device_id: null,
    device_label: null,
    desired_bridge_version: null,
    bridge_version: null,
  };
}

function workingDirectories(
  value: Json | null,
  field: string,
): BridgeWorkingDirectory[] | null {
  const parsed = bridgeWorkingDirectoriesSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      `Bridge ${field} working directories are invalid`,
    );
  }
  return parsed.data;
}

function desiredConfiguration(
  row: AIConnectionBridgeSettingsRow,
): BridgeDesiredConfiguration {
  return {
    enabled: row.desired_enabled,
    include_thread_titles: row.desired_include_thread_titles,
    max_threads: row.desired_max_threads,
    max_concurrent_turns: row.desired_max_concurrent_turns,
    sync_history: row.desired_sync_history,
    history_turn_limit: row.desired_history_turn_limit,
    working_directories: workingDirectories(
      row.desired_working_directories,
      "desired",
    ),
    permission_mode: row.desired_permission_mode ?? null,
    approval_mode: row.desired_approval_mode ?? null,
  };
}

function appliedConfiguration(
  row: AIConnectionBridgeSettingsRow,
): BridgeAppliedConfiguration | null {
  if (!row.applied_at) return null;

  const constraintValues = [
    row.constraint_remote_configuration_enabled,
    row.constraint_allow_thread_titles,
    row.constraint_max_threads,
    row.constraint_max_concurrent_turns,
    row.constraint_thread_scope,
    row.constraint_working_directory,
    row.constraint_fixed_thread,
    row.constraint_permission_mode,
    row.constraint_approval_mode,
    row.constraint_allow_history_sync,
    row.constraint_max_history_turns,
    row.constraint_allow_working_directory_configuration,
  ];
  if (constraintValues.some((value) => value === null)) {
    throw new AppError("INTERNAL_ERROR", "Bridge configuration status is incomplete");
  }

  const constraints: BridgeConfigurationConstraints = {
    remote_configuration_enabled:
      row.constraint_remote_configuration_enabled as boolean,
    allow_thread_titles: row.constraint_allow_thread_titles as boolean,
    max_threads: row.constraint_max_threads as number,
    max_concurrent_turns: row.constraint_max_concurrent_turns as number,
    thread_scope: row.constraint_thread_scope as "cwd" | "all",
    working_directory: row.constraint_working_directory as string,
    fixed_thread: row.constraint_fixed_thread as boolean,
    permission_mode: row.constraint_permission_mode as
      | "safe"
      | "inherit"
      | "danger-full-access",
    approval_mode: row.constraint_approval_mode as
      | "decline"
      | "accept"
      | "accept-session",
    allow_history_sync: row.constraint_allow_history_sync as boolean,
    max_history_turns: row.constraint_max_history_turns as number,
    allow_working_directory_configuration:
      row.constraint_allow_working_directory_configuration as boolean,
  };

  const effectiveValues = [
    row.effective_enabled,
    row.effective_include_thread_titles,
    row.effective_max_threads,
    row.effective_max_concurrent_turns,
    row.effective_sync_history,
    row.effective_history_turn_limit,
  ];
  const hasEffective = effectiveValues.every((value) => value !== null);
  const hasNoEffective = effectiveValues.every((value) => value === null);
  if (!hasEffective && !hasNoEffective) {
    throw new AppError("INTERNAL_ERROR", "Bridge effective configuration is incomplete");
  }

  return {
    version: row.applied_version,
    effective: hasEffective
      ? {
          enabled: row.effective_enabled as boolean,
          include_thread_titles:
            row.effective_include_thread_titles as boolean,
          max_threads: row.effective_max_threads as number,
          max_concurrent_turns:
            row.effective_max_concurrent_turns as number,
          sync_history: row.effective_sync_history as boolean,
          history_turn_limit: row.effective_history_turn_limit as number,
          working_directories: workingDirectories(
            row.effective_working_directories,
            "effective",
          ),
          // Older rows report the modes only through constraints; treat them
          // as the effective value until a new Bridge report replaces it.
          permission_mode:
            (row.effective_permission_mode ??
              row.constraint_permission_mode) as
              | "safe"
              | "inherit"
              | "danger-full-access",
          approval_mode: (row.effective_approval_mode ??
            row.constraint_approval_mode) as
            | "decline"
            | "accept"
            | "accept-session",
        }
      : null,
    constraints,
    error: row.error,
    applied_at: row.applied_at,
  };
}

export function bridgeConfigurationDto(
  row: AIConnectionBridgeSettingsRow,
): BridgeConfigurationResponse {
  const configuration: BridgeConfiguration = {
    connection_id: row.connection_id,
    platform: row.platform,
    version: row.version,
    desired: desiredConfiguration(row),
    applied: appliedConfiguration(row),
    runtime: {
      online:
        row.active_runtime_lease_expires_at !== null &&
        Date.parse(row.active_runtime_lease_expires_at) > Date.now(),
      lease_expires_at: row.active_runtime_lease_expires_at,
    },
    desired_bridge_version: row.desired_bridge_version,
    updated_at: row.updated_at,
  };
  return { configuration };
}

function requireOwnerContext(context: UserWorkspaceContext) {
  if (context.role !== "owner") {
    throw new AppError("FORBIDDEN", "Workspace owner access is required");
  }
}

export async function getBridgeConfiguration(
  context: UserWorkspaceContext,
  connectionId: string,
  platform?: string,
): Promise<BridgeConfigurationResponse> {
  requireOwnerContext(context);
  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("ai_connections")
    .select("id, platform")
    .eq("workspace_id", context.workspaceId)
    .eq("id", connectionId)
    .is("revoked_at", null)
    .maybeSingle();
  if (connectionError) throw mapDatabaseError(connectionError);
  if (!connection) {
    throw new AppError("FORBIDDEN", "The Bridge connection is not accessible");
  }
  const platformKey = canonicalBridgeKind(platform ?? connection.platform);

  let { data, error } = await admin
    .from("ai_connection_bridge_settings")
    .select(BRIDGE_SETTINGS_COLUMNS)
    .eq("workspace_id", context.workspaceId)
    .eq("connection_id", connectionId)
    .eq("platform", platformKey)
    .maybeSingle();
  if (error && isMissingWorkingDirectorySchema(error)) {
    const legacyResult = await admin
      .from("ai_connection_bridge_settings")
      .select(LEGACY_BRIDGE_SETTINGS_COLUMNS)
      .eq("workspace_id", context.workspaceId)
      .eq("connection_id", connectionId)
      .eq("platform", platformKey)
      .maybeSingle();
    data = legacyResult.data
      ? withWorkingDirectoryDefaults(
          legacyResult.data as unknown as LegacyBridgeSettingsRow,
        )
      : null;
    error = legacyResult.error;
  }
  if (error) throw mapDatabaseError(error);
  if (!data) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Bridge configuration was not initialized for this platform",
    );
  }
  return bridgeConfigurationDto(data);
}

export async function updateBridgeConfiguration(
  context: UserWorkspaceContext,
  connectionId: string,
  platform: string | undefined,
  input: UpdateBridgeConfigurationInput,
  idempotencyKey: string,
): Promise<BridgeConfigurationResponse> {
  requireOwnerContext(context);
  const admin = createAdminClient();
  const platformKey = platform
    ? canonicalBridgeKind(platform)
    : await (async () => {
        const { data: connection, error } = await admin
          .from("ai_connections")
          .select("platform")
          .eq("workspace_id", context.workspaceId)
          .eq("id", connectionId)
          .is("revoked_at", null)
          .maybeSingle();
        if (error) throw mapDatabaseError(error);
        if (!connection) {
          throw new AppError(
            "FORBIDDEN",
            "The Bridge connection is not accessible",
          );
        }
        return canonicalBridgeKind(connection.platform);
      })();
  const parameters = {
    p_workspace_id: context.workspaceId,
    p_user_id: context.userId,
    p_connection_id: connectionId,
    p_platform: platformKey,
    p_expected_version: input.expected_version,
    p_enabled: input.enabled,
    p_include_thread_titles: input.include_thread_titles,
    p_max_threads: input.max_threads,
    p_max_concurrent_turns: input.max_concurrent_turns,
    p_sync_history: input.sync_history,
    p_history_turn_limit: input.history_turn_limit,
    p_working_directories: input.working_directories as Json | null,
    p_permission_mode: input.permission_mode,
    p_approval_mode: input.approval_mode,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("update_ai_connection_bridge_config", {
      connectionId,
      platform: platformKey,
      ...input,
    }),
  };
  const result = await admin.rpc(
    "update_ai_connection_bridge_config",
    parameters,
  );
  if (!result.error) return result.data;
  if (!isMissingWorkingDirectorySchema(result.error)) {
    throw mapDatabaseError(result.error);
  }
  if (input.working_directories !== null) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Bridge working-directory configuration is waiting for its database migration",
    );
  }

  const legacyParameters: Partial<typeof parameters> = { ...parameters };
  delete legacyParameters.p_working_directories;
  delete legacyParameters.p_permission_mode;
  delete legacyParameters.p_approval_mode;
  const legacyClient = admin as unknown as {
    rpc: (
      functionName: string,
      parameters: Record<string, unknown>,
    ) => Promise<{
      data: BridgeConfigurationResponse | null;
      error: DatabaseErrorLike | null;
    }>;
  };
  const legacyResult = await legacyClient.rpc(
    "update_ai_connection_bridge_config",
    legacyParameters,
  );
  if (legacyResult.error) throw mapDatabaseError(legacyResult.error);
  if (!legacyResult.data) {
    throw new AppError("INTERNAL_ERROR", "Bridge configuration was not returned");
  }
  return legacyResult.data;
}

/**
 * 把 owner 设置的期望 Bridge 版本注入交换响应（独立于 RPC，列缺失时静默省略），
 * Bridge 据此在设备授权时执行自更新。
 */
async function attachDesiredBridgeVersion(
  auth: AIAuthContext,
  response: BridgeConfigurationResponse,
  platform: string,
): Promise<BridgeConfigurationResponse> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_connection_bridge_settings")
    .select("desired_bridge_version")
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", auth.connectionId)
    .eq("platform", canonicalBridgeKind(platform))
    .maybeSingle();
  if (error) {
    if (isMissingWorkingDirectorySchema(error)) return response;
    throw mapDatabaseError(error);
  }
  return {
    configuration: {
      ...response.configuration,
      desired_bridge_version:
        (data as { desired_bridge_version?: string | null } | null)
          ?.desired_bridge_version ?? null,
    },
  };
}

export async function exchangeBridgeConfiguration(
  auth: AIAuthContext,
  input: ExchangeBridgeConfigurationInput,
): Promise<BridgeConfigurationResponse> {
  const platform = canonicalBridgeKind(input.platform ?? auth.platform);
  const parameters = {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_platform: platform,
    p_runtime_instance_id: input.runtime_instance_id,
    p_report_sequence: input.report_sequence,
    p_lease_seconds: input.lease_seconds,
    p_release_runtime: input.release_runtime,
    p_applied_version: input.applied_version,
    p_effective: input.effective as Json | null,
    p_constraints: input.constraints as Json,
    p_error: input.error,
  };
  try {
    return await attachDesiredBridgeVersion(
      auth,
      await callDomainRpc("exchange_ai_connection_bridge_config", parameters),
      platform,
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "INVALID_REQUEST") {
      throw error;
    }

    // The 0.8 Bridge reports its effective directory list on every exchange.
    // During a rolling database migration the 0.4 RPC still accepts the rest
    // of the status envelope, so retry without only the two new JSON fields.
    const legacyEffective: Partial<NonNullable<typeof input.effective>> | null =
      input.effective ? { ...input.effective } : null;
    if (legacyEffective) delete legacyEffective.working_directories;
    const legacyConstraints: Partial<typeof input.constraints> = {
      ...input.constraints,
    };
    delete legacyConstraints.allow_working_directory_configuration;
    return attachDesiredBridgeVersion(
      auth,
      await callDomainRpc("exchange_ai_connection_bridge_config", {
        ...parameters,
        p_effective: legacyEffective as Json | null,
        p_constraints: legacyConstraints as Json,
      }),
      platform,
    );
  }
}

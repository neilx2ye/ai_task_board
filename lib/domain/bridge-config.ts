import "server-only";

import { hashRequest } from "@/lib/auth/ai-token";
import type { UserWorkspaceContext } from "@/lib/auth/user";
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
  Json,
} from "@/lib/types/database";
import type { AIAuthContext } from "@/lib/types/domain";
import type {
  ExchangeBridgeConfigurationInput,
  UpdateBridgeConfigurationInput,
} from "@/lib/validation/bridge-config";

const BRIDGE_SETTINGS_COLUMNS =
  "connection_id, workspace_id, version, desired_enabled, desired_include_thread_titles, desired_max_threads, desired_max_concurrent_turns, applied_version, effective_enabled, effective_include_thread_titles, effective_max_threads, effective_max_concurrent_turns, constraint_remote_configuration_enabled, constraint_allow_thread_titles, constraint_max_threads, constraint_max_concurrent_turns, constraint_thread_scope, constraint_working_directory, constraint_fixed_thread, constraint_permission_mode, constraint_approval_mode, error, applied_at, active_runtime_instance_id, active_runtime_last_sequence, active_runtime_lease_expires_at, created_at, updated_at" as const;

function desiredConfiguration(
  row: AIConnectionBridgeSettingsRow,
): BridgeDesiredConfiguration {
  return {
    enabled: row.desired_enabled,
    include_thread_titles: row.desired_include_thread_titles,
    max_threads: row.desired_max_threads,
    max_concurrent_turns: row.desired_max_concurrent_turns,
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
    permission_mode: row.constraint_permission_mode as "safe" | "inherit",
    approval_mode: row.constraint_approval_mode as
      | "decline"
      | "accept"
      | "accept-session",
  };

  const effectiveValues = [
    row.effective_enabled,
    row.effective_include_thread_titles,
    row.effective_max_threads,
    row.effective_max_concurrent_turns,
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
    version: row.version,
    desired: desiredConfiguration(row),
    applied: appliedConfiguration(row),
    runtime: {
      online:
        row.active_runtime_lease_expires_at !== null &&
        Date.parse(row.active_runtime_lease_expires_at) > Date.now(),
      lease_expires_at: row.active_runtime_lease_expires_at,
    },
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
): Promise<BridgeConfigurationResponse> {
  requireOwnerContext(context);
  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("ai_connections")
    .select("id")
    .eq("workspace_id", context.workspaceId)
    .eq("id", connectionId)
    .is("revoked_at", null)
    .maybeSingle();
  if (connectionError) throw mapDatabaseError(connectionError);
  if (!connection) {
    throw new AppError("FORBIDDEN", "The Bridge connection is not accessible");
  }

  const { data, error } = await admin
    .from("ai_connection_bridge_settings")
    .select(BRIDGE_SETTINGS_COLUMNS)
    .eq("workspace_id", context.workspaceId)
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!data) {
    throw new AppError("INTERNAL_ERROR", "Bridge configuration was not initialized");
  }
  return bridgeConfigurationDto(data);
}

export async function updateBridgeConfiguration(
  context: UserWorkspaceContext,
  connectionId: string,
  input: UpdateBridgeConfigurationInput,
  idempotencyKey: string,
): Promise<BridgeConfigurationResponse> {
  requireOwnerContext(context);
  return callDomainRpc("update_ai_connection_bridge_config", {
    p_workspace_id: context.workspaceId,
    p_user_id: context.userId,
    p_connection_id: connectionId,
    p_expected_version: input.expected_version,
    p_enabled: input.enabled,
    p_include_thread_titles: input.include_thread_titles,
    p_max_threads: input.max_threads,
    p_max_concurrent_turns: input.max_concurrent_turns,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("update_ai_connection_bridge_config", {
      connectionId,
      ...input,
    }),
  });
}

export async function exchangeBridgeConfiguration(
  auth: AIAuthContext,
  input: ExchangeBridgeConfigurationInput,
): Promise<BridgeConfigurationResponse> {
  return callDomainRpc("exchange_ai_connection_bridge_config", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_runtime_instance_id: input.runtime_instance_id,
    p_report_sequence: input.report_sequence,
    p_lease_seconds: input.lease_seconds,
    p_release_runtime: input.release_runtime,
    p_applied_version: input.applied_version,
    p_effective: input.effective as Json | null,
    p_constraints: input.constraints as Json,
    p_error: input.error,
  });
}

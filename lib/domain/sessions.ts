import "server-only";

import { hashRequest } from "@/lib/auth/ai-token";
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
  const parameters = {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_bridge_version: input.bridge_version,
    p_directories: input.directories
      ? (JSON.parse(JSON.stringify(input.directories)) as Json)
      : null,
    // Zod defaults normalize every thread, while this boundary also removes
    // optional `undefined` keys before handing the value to supabase-js.
    p_threads: JSON.parse(JSON.stringify(input.threads)) as Json,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("sync_ai_sessions_with_directories", input),
  };
  const { data, error } = await createAdminClient().rpc(
    "sync_ai_sessions_with_directories",
    parameters,
  );
  if (!error) return data;
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
  return callDomainRpc("sync_ai_sessions", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_bridge_version: input.bridge_version,
    p_threads: JSON.parse(JSON.stringify(legacyThreads)) as Json,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("sync_ai_sessions", legacyInput),
  });
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

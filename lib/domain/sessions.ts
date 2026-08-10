import "server-only";

import { hashRequest } from "@/lib/auth/ai-token";
import { callDomainRpc } from "@/lib/domain/rpc";
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
  return callDomainRpc("sync_ai_sessions", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_bridge_version: input.bridge_version,
    // Zod defaults normalize every thread, while this boundary also removes
    // optional `undefined` keys before handing the value to supabase-js.
    p_threads: JSON.parse(JSON.stringify(input.threads)) as Json,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("sync_ai_sessions", input),
  });
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

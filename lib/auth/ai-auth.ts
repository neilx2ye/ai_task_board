import "server-only";

import { hashToken } from "@/lib/auth/ai-token";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AIAuthContext, AISessionContext } from "@/lib/types/domain";
import { uuidSchema } from "@/lib/validation/common";

const CONNECTION_USAGE_REFRESH_MS = 5 * 60 * 1_000;

export function shouldRefreshConnectionUsage(
  lastUsedAt: string | null,
  nowMs: number,
): boolean {
  if (!lastUsedAt) return true;
  const lastUsedMs = Date.parse(lastUsedAt);
  return !Number.isFinite(lastUsedMs) || nowMs - lastUsedMs >= CONNECTION_USAGE_REFRESH_MS;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match?.[1]) {
    throw new AppError("AUTHENTICATION_REQUIRED", "A bearer connection token is required");
  }
  return match[1];
}

export async function authenticateAIRequest(request: Request): Promise<AIAuthContext> {
  const tokenHash = hashToken(bearerToken(request));
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_connections")
    .select("id, workspace_id, last_used_at")
    .eq("api_token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) throw mapDatabaseError(error);
  if (!data) {
    throw new AppError("AUTHENTICATION_REQUIRED", "The connection token is invalid or revoked");
  }

  const nowMs = Date.now();
  if (shouldRefreshConnectionUsage(data.last_used_at, nowMs)) {
    const staleBefore = new Date(nowMs - CONNECTION_USAGE_REFRESH_MS).toISOString();
    const { error: updateError } = await admin
      .from("ai_connections")
      .update({ last_used_at: new Date(nowMs).toISOString() })
      .eq("id", data.id)
      .or(`last_used_at.is.null,last_used_at.lt.${staleBefore}`);
    if (updateError) throw mapDatabaseError(updateError);
  }

  return { connectionId: data.id, workspaceId: data.workspace_id, tokenHash };
}

export async function authorizeAISession(
  auth: AIAuthContext,
  sessionId: string,
): Promise<AISessionContext> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("connection_id", auth.connectionId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!data) {
    throw new AppError("SESSION_NOT_AUTHORIZED", "The session does not belong to this connection");
  }
  return {
    ...auth,
    sessionId: data.id,
  };
}

export function sessionIdFromRequest(request: Request): string {
  const value = request.headers.get("x-ai-session-id")?.trim();
  if (!value) {
    throw new AppError("SESSION_NOT_AUTHORIZED", "X-AI-Session-ID is required");
  }
  return uuidSchema.parse(value);
}

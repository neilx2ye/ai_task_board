import "server-only";

import { mapDatabaseError } from "@/lib/domain/errors";
import { callDomainRpc } from "@/lib/domain/rpc";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AIAuthContext } from "@/lib/types/domain";
import type {
  ClaimThreadCommandInput,
  CompleteThreadCommandInput,
} from "@/lib/validation/ai";

export function claimThreadCommand(
  auth: AIAuthContext,
  input: ClaimThreadCommandInput,
) {
  return callDomainRpc("claim_ai_thread_command", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_runtime_instance_id: input.runtime_instance_id,
    p_lease_seconds: input.lease_seconds,
  });
}

/**
 * Codex omits a newly started Thread from thread/list until its first Turn.
 * Keep successful Web creates discoverable by exact id so the Bridge can read
 * and publish those otherwise-empty Threads across inventory cycles/restarts.
 */
export async function listCreatedThreadIds(auth: AIAuthContext) {
  const admin = createAdminClient();
  const [creates, deletes] = await Promise.all([
    admin
      .from("ai_thread_commands")
      .select("external_thread_id")
      .eq("workspace_id", auth.workspaceId)
      .eq("connection_id", auth.connectionId)
      .eq("action", "create")
      .eq("status", "succeeded")
      .not("external_thread_id", "is", null)
      .order("completed_at", { ascending: false })
      .limit(500),
    admin
      .from("ai_thread_commands")
      .select("external_thread_id")
      .eq("workspace_id", auth.workspaceId)
      .eq("connection_id", auth.connectionId)
      .eq("action", "delete")
      .eq("status", "succeeded")
      .not("external_thread_id", "is", null)
      .limit(500),
  ]);
  if (creates.error) throw mapDatabaseError(creates.error);
  if (deletes.error) throw mapDatabaseError(deletes.error);

  const deletedIds = new Set(
    (deletes.data ?? []).flatMap((command) =>
      command.external_thread_id ? [command.external_thread_id] : [],
    ),
  );
  const threadIds = [
    ...new Set(
      (creates.data ?? []).flatMap((command) =>
        command.external_thread_id &&
        !deletedIds.has(command.external_thread_id)
          ? [command.external_thread_id]
          : [],
      ),
    ),
  ];
  return { thread_ids: threadIds };
}

export function completeThreadCommand(
  auth: AIAuthContext,
  commandId: string,
  input: CompleteThreadCommandInput,
) {
  return callDomainRpc("complete_ai_thread_command", {
    p_workspace_id: auth.workspaceId,
    p_connection_id: auth.connectionId,
    p_api_token_hash: auth.tokenHash,
    p_runtime_instance_id: input.runtime_instance_id,
    p_command_id: commandId,
    p_succeeded: input.succeeded,
    p_external_thread_id: input.external_thread_id ?? null,
    p_error: input.error ?? null,
  });
}

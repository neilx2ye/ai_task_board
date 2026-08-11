import "server-only";

import { callDomainRpc } from "@/lib/domain/rpc";
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

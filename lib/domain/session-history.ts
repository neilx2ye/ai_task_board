import "server-only";

import { callDomainRpc } from "@/lib/domain/rpc";
import type { Json } from "@/lib/types/database";
import type { AISessionContext } from "@/lib/types/domain";
import type { ImportSessionHistoryInput } from "@/lib/validation/ai";

/**
 * Import a normalized Codex history batch without manufacturing a Board task.
 * Row-level external references provide retry safety; the database owns the
 * runtime fence, append-only conflict check, and cumulative sync status.
 */
export async function importSessionHistory(
  context: AISessionContext,
  input: ImportSessionHistoryInput,
) {
  // History keeps the human prompt and final AI reply so imported turns remain
  // readable as conversations. Reasoning summaries still stay outside the
  // persistence boundary, including when sent by an older/custom Bridge.
  const items = input.items.filter(
    (item) =>
      item.kind === "user_message" || item.kind === "assistant_message",
  );
  return callDomainRpc("import_session_history", {
    p_workspace_id: context.workspaceId,
    p_connection_id: context.connectionId,
    p_api_token_hash: context.tokenHash,
    p_session_id: context.sessionId,
    p_runtime_instance_id: input.runtime_instance_id,
    p_report_sequence: input.report_sequence,
    p_items: items as Json,
    p_sync: input.sync as Json,
  });
}

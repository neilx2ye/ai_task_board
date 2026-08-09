import "server-only";

import { deriveClaimToken, hashRequest, hashToken } from "@/lib/auth/ai-token";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import {
  callDomainRpc,
  isRecord,
  type DomainFunctionArgs,
} from "@/lib/domain/rpc";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AISessionContext, TaskDetails, TaskUpdates } from "@/lib/types/domain";
import type { Json, TaskDatabaseRow, TaskRow } from "@/lib/types/database";
import type {
  ClaimOptionsInput,
  ClaimTaskInput,
  CompleteTaskInput,
  CreateSubtasksInput,
  FailTaskInput,
  HeartbeatClaimInput,
  PostTaskMessageInput,
  ReleaseTaskInput,
  ReportCurrentTaskInput,
  ReportProgressInput,
  RequestUserInputInput,
} from "@/lib/validation/ai";

const DEFAULT_LEASE_SECONDS = 15 * 60;

type RequestMetadata = Pick<
  DomainFunctionArgs<"claim_task">,
  "p_idempotency_key" | "p_request_hash"
>;

type AIContextParameters = Pick<
  DomainFunctionArgs<"claim_task">,
  "p_workspace_id" | "p_connection_id" | "p_api_token_hash" | "p_session_id"
>;

type CompletionParameters = Pick<
  DomainFunctionArgs<"complete_task">,
  | "p_task_id"
  | "p_claim_token_hash"
  | "p_result_summary"
  | "p_result_json"
  | "p_message_content"
  | "p_artifacts"
>;

export const SAFE_TASK_COLUMNS =
  "id, workspace_id, parent_task_id, root_task_id, title, description, acceptance_criteria, status, priority, position, assigned_session_id, claimed_by_session_id, claimed_at, lease_expires_at, required_capabilities, external_source, external_task_ref, external_conversation_ref, progress_note, progress_percent_estimate, result_summary, result_json, created_by_type, created_by_id, created_at, updated_at, completed_at" as const;

function requestMetadata(
  operation: string,
  input: unknown,
  idempotencyKey: string,
): RequestMetadata {
  return {
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest(operation, input),
  };
}

function aiContext(context: AISessionContext): AIContextParameters {
  return {
    p_workspace_id: context.workspaceId,
    p_connection_id: context.connectionId,
    p_api_token_hash: context.tokenHash,
    p_session_id: context.sessionId,
  };
}

function issuedClaimToken(
  context: AISessionContext,
  operation: string,
  idempotencyKey: string,
): string {
  return deriveClaimToken(
    `${context.workspaceId}\0${context.connectionId}\0${context.sessionId}\0${operation}\0${idempotencyKey}`,
  );
}

function asJson(value: unknown): Json | null {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value)) as Json;
}

function withClaimToken(result: unknown, token: string, key = "task"): unknown {
  if (!isRecord(result)) return result;
  const task = result[key];
  if (!isRecord(task)) return result;
  return { ...result, [key]: { ...task, claim_token: token } };
}

/** Remove the claim hash at the only boundary used by direct admin reads. */
export function sanitizeTask(task: TaskRow | TaskDatabaseRow): TaskRow {
  const safe = { ...task } as TaskRow & { claim_token_hash?: unknown };
  Reflect.deleteProperty(safe, "claim_token_hash");
  return safe;
}

export async function reportCurrentTask(
  context: AISessionContext,
  input: ReportCurrentTaskInput,
  idempotencyKey: string,
): Promise<unknown> {
  const claimToken = issuedClaimToken(context, "report_current_task", idempotencyKey);
  const result = await callDomainRpc("report_current_task", {
    ...aiContext(context),
    p_title: input.title,
    p_description: input.description ?? null,
    p_acceptance_criteria: input.acceptance_criteria ?? null,
    p_external_source: input.external_source ?? null,
    p_external_conversation_ref: input.external_conversation_ref ?? null,
    p_external_task_ref: input.external_task_ref,
    p_priority: input.priority,
    p_progress_note: input.progress_note ?? null,
    p_progress_percent_estimate: input.progress_percent_estimate ?? null,
    p_required_capabilities: input.required_capabilities,
    p_claim_token_hash: hashToken(claimToken, "claim"),
    p_lease_seconds: DEFAULT_LEASE_SECONDS,
    ...requestMetadata("report_current_task", input, idempotencyKey),
  });
  return withClaimToken(result, claimToken);
}

export async function claimNextTask(
  context: AISessionContext,
  input: ClaimOptionsInput,
  idempotencyKey: string,
): Promise<unknown> {
  const claimToken = issuedClaimToken(context, "claim_next_task", idempotencyKey);
  const result = await callDomainRpc("claim_next_task", {
    ...aiContext(context),
    p_claim_token_hash: hashToken(claimToken, "claim"),
    p_lease_seconds: input.lease_seconds ?? DEFAULT_LEASE_SECONDS,
    ...requestMetadata("claim_next_task", input, idempotencyKey),
  });
  return withClaimToken(result, claimToken);
}

export async function claimTask(
  context: AISessionContext,
  input: ClaimTaskInput,
  idempotencyKey: string,
): Promise<unknown> {
  const claimToken = issuedClaimToken(context, "claim_task", idempotencyKey);
  const result = await callDomainRpc("claim_task", {
    ...aiContext(context),
    p_task_id: input.task_id,
    p_claim_token_hash: hashToken(claimToken, "claim"),
    p_lease_seconds: input.lease_seconds ?? DEFAULT_LEASE_SECONDS,
    ...requestMetadata("claim_task", input, idempotencyKey),
  });
  return withClaimToken(result, claimToken);
}

export async function heartbeatClaim(
  context: AISessionContext,
  input: HeartbeatClaimInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("heartbeat_claim", {
    ...aiContext(context),
    p_task_id: input.task_id,
    p_claim_token_hash: hashToken(input.claim_token, "claim"),
    p_lease_seconds: input.lease_seconds ?? DEFAULT_LEASE_SECONDS,
    ...requestMetadata("heartbeat_claim", input, idempotencyKey),
  });
}

export async function createSubtasks(
  context: AISessionContext,
  input: CreateSubtasksInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("create_subtasks", {
    ...aiContext(context),
    p_parent_task_id: input.task_id,
    p_claim_token_hash: hashToken(input.claim_token, "claim"),
    p_subtasks: input.subtasks,
    ...requestMetadata("create_subtasks", input, idempotencyKey),
  });
}

export async function reportProgress(
  context: AISessionContext,
  input: ReportProgressInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("report_progress", {
    ...aiContext(context),
    p_task_id: input.task_id,
    p_claim_token_hash: hashToken(input.claim_token, "claim"),
    p_progress_note: input.progress_note,
    p_progress_percent_estimate: input.progress_percent_estimate ?? null,
    ...requestMetadata("report_progress", input, idempotencyKey),
  });
}

export async function requestUserInput(
  context: AISessionContext,
  input: RequestUserInputInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("request_user_input", {
    ...aiContext(context),
    p_task_id: input.task_id,
    p_claim_token_hash: hashToken(input.claim_token, "claim"),
    p_question: input.question,
    ...requestMetadata("request_user_input", input, idempotencyKey),
  });
}

export async function postTaskMessage(
  context: AISessionContext,
  input: PostTaskMessageInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("post_task_message", {
    ...aiContext(context),
    p_task_id: input.task_id,
    p_claim_token_hash: hashToken(input.claim_token, "claim"),
    p_content: input.content,
    p_reply_to_message_id: input.reply_to_message_id ?? null,
    ...requestMetadata("post_task_message", input, idempotencyKey),
  });
}

function completionParameters(input: CompleteTaskInput): CompletionParameters {
  return {
    p_task_id: input.task_id,
    p_claim_token_hash: hashToken(input.claim_token, "claim"),
    p_result_summary: input.result_summary ?? null,
    p_result_json: asJson(input.result_json),
    p_message_content: input.message ?? null,
    p_artifacts: input.artifacts,
  };
}

export async function completeTask(
  context: AISessionContext,
  input: CompleteTaskInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("complete_task", {
    ...aiContext(context),
    ...completionParameters(input),
    ...requestMetadata("complete_task", input, idempotencyKey),
  });
}

export async function completeTaskAndClaimNext(
  context: AISessionContext,
  input: CompleteTaskInput & ClaimOptionsInput,
  idempotencyKey: string,
): Promise<unknown> {
  const nextClaimToken = issuedClaimToken(
    context,
    "complete_task_and_claim_next",
    idempotencyKey,
  );
  const result = await callDomainRpc("complete_task_and_claim_next", {
    ...aiContext(context),
    ...completionParameters(input),
    p_next_claim_token_hash: hashToken(nextClaimToken, "claim"),
    p_lease_seconds: input.lease_seconds ?? DEFAULT_LEASE_SECONDS,
    ...requestMetadata("complete_task_and_claim_next", input, idempotencyKey),
  });
  return withClaimToken(result, nextClaimToken, "next_task");
}

export async function failTask(
  context: AISessionContext,
  input: FailTaskInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("fail_task", {
    ...aiContext(context),
    p_task_id: input.task_id,
    p_claim_token_hash: hashToken(input.claim_token, "claim"),
    p_reason: input.reason,
    p_result_json: asJson(input.result_json),
    ...requestMetadata("fail_task", input, idempotencyKey),
  });
}

export async function releaseTask(
  context: AISessionContext,
  input: ReleaseTaskInput,
  idempotencyKey: string,
): Promise<unknown> {
  return callDomainRpc("release_task", {
    ...aiContext(context),
    p_task_id: input.task_id,
    p_claim_token_hash: hashToken(input.claim_token, "claim"),
    p_reason: input.reason ?? null,
    ...requestMetadata("release_task", input, idempotencyKey),
  });
}

export async function getTask(
  context: AISessionContext,
  taskId: string,
): Promise<TaskDetails> {
  const admin = createAdminClient();
  const { data: task, error } = await admin
    .from("tasks")
    .select(SAFE_TASK_COLUMNS)
    .eq("id", taskId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!task) throw new AppError("TASK_NOT_FOUND", "Task not found");

  return loadTaskRelations(context.workspaceId, task);
}

export async function loadTaskRelations(
  workspaceId: string,
  task: TaskRow | TaskDatabaseRow,
  includeDescendantActivity = false,
): Promise<TaskDetails> {
  const admin = createAdminClient();
  const descendantRows: TaskRow[] = [];
  if (includeDescendantActivity) {
    const { data: treeRows, error: treeError } = await admin
      .from("tasks")
      .select(SAFE_TASK_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("root_task_id", task.root_task_id)
      .order("created_at");
    if (treeError) throw mapDatabaseError(treeError);
    const childrenByParent = new Map<string, TaskRow[]>();
    for (const row of treeRows ?? []) {
      if (!row.parent_task_id) continue;
      const siblings = childrenByParent.get(row.parent_task_id) ?? [];
      siblings.push(row);
      childrenByParent.set(row.parent_task_id, siblings);
    }
    const queue = [task.id];
    const visited = new Set(queue);
    while (queue.length) {
      const parentId = queue.shift();
      if (!parentId) break;
      for (const child of childrenByParent.get(parentId) ?? []) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        descendantRows.push(child);
        queue.push(child.id);
      }
    }
  }
  const activityTaskIds = [task.id, ...descendantRows.map((row) => row.id)];
  const [parentResult, childrenResult, dependenciesResult, messagesResult, eventsResult, artifactsResult] =
    await Promise.all([
      task.parent_task_id
        ? admin
            .from("tasks")
            .select(SAFE_TASK_COLUMNS)
            .eq("id", task.parent_task_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      admin
        .from("tasks")
        .select(SAFE_TASK_COLUMNS)
        .eq("workspace_id", workspaceId)
        .eq("parent_task_id", task.id)
        .order("position")
        .order("created_at"),
      admin.from("task_dependencies").select("depends_on_task_id").eq("task_id", task.id),
      admin
        .from("task_messages")
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("task_id", activityTaskIds)
        .order("created_at"),
      admin
        .from("task_events")
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("task_id", activityTaskIds)
        .order("id"),
      admin
        .from("artifacts")
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("task_id", activityTaskIds)
        .order("created_at"),
    ]);

  const firstError = [
    parentResult.error,
    childrenResult.error,
    dependenciesResult.error,
    messagesResult.error,
    eventsResult.error,
    artifactsResult.error,
  ].find(Boolean);
  if (firstError) throw mapDatabaseError(firstError);

  const dependencyIds = (dependenciesResult.data ?? []).map((row) => row.depends_on_task_id);
  let dependencies: TaskRow[] = [];
  if (dependencyIds.length) {
    const { data, error: dependencyError } = await admin
      .from("tasks")
      .select(SAFE_TASK_COLUMNS)
      .eq("workspace_id", workspaceId)
      .in("id", dependencyIds);
    if (dependencyError) throw mapDatabaseError(dependencyError);
    dependencies = (data ?? []).map(sanitizeTask);
  }

  return {
    task: sanitizeTask(task),
    parent: parentResult.data ? sanitizeTask(parentResult.data) : null,
    children: (childrenResult.data ?? []).map(sanitizeTask),
    descendants: descendantRows.map(sanitizeTask),
    dependencies,
    messages: messagesResult.data ?? [],
    events: eventsResult.data ?? [],
    artifacts: artifactsResult.data ?? [],
  };
}

export async function getTaskUpdates(
  context: AISessionContext,
  taskId: string,
  after: number,
  limit: number,
): Promise<TaskUpdates> {
  const admin = createAdminClient();
  const { data: task, error: taskError } = await admin
    .from("tasks")
    .select("id")
    .eq("id", taskId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (taskError) throw mapDatabaseError(taskError);
  if (!task) throw new AppError("TASK_NOT_FOUND", "Task not found");

  const [eventsResult, messagesResult, artifactsResult] = await Promise.all([
    admin
      .from("task_events")
      .select("*")
      .eq("task_id", taskId)
      .gt("id", after)
      .order("id")
      .limit(limit),
    admin.from("task_messages").select("*").eq("task_id", taskId).order("created_at"),
    admin.from("artifacts").select("*").eq("task_id", taskId).order("created_at"),
  ]);
  const firstError = [eventsResult.error, messagesResult.error, artifactsResult.error].find(Boolean);
  if (firstError) throw mapDatabaseError(firstError);
  const events = eventsResult.data ?? [];
  return {
    task_id: taskId,
    events,
    messages: messagesResult.data ?? [],
    artifacts: artifactsResult.data ?? [],
    next_cursor: events.at(-1)?.id ?? after,
  };
}

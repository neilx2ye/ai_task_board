import "server-only";

import { deriveStableUuid, hashRequest } from "@/lib/auth/ai-token";
import type { UserWorkspaceContext } from "@/lib/auth/user";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import { callDomainRpc } from "@/lib/domain/rpc";
import { taskTitleFromPrompt } from "@/lib/domain/task-title";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TurnPlanStep } from "@/lib/types/domain";
import type {
  SessionTurnPlanRow,
  TaskStatus,
} from "@/lib/types/database";
import type {
  CreateTurnPlanStepInput,
  UpdateTurnPlanStepInput,
  UpsertThreadPlanningNotesInput,
  UpsertPlanningNotesInput,
} from "@/lib/validation/user";

export async function getPlanningNote(
  context: UserWorkspaceContext,
  projectRef: string,
) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("planning_notes")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("project_ref", projectRef)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  return { note: data };
}

export async function upsertPlanningNote(
  context: UserWorkspaceContext,
  input: UpsertPlanningNotesInput,
) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("planning_notes")
    .upsert(
      {
        workspace_id: context.workspaceId,
        project_ref: input.project_ref,
        content: input.content,
        updated_by: context.userId,
      },
      { onConflict: "workspace_id,project_ref" },
    )
    .select("*")
    .single();
  if (error) throw mapDatabaseError(error);
  return { note: data };
}

export async function getThreadPlanningNote(
  context: UserWorkspaceContext,
  sessionId: string,
) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("thread_planning_notes")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  return { note: data };
}

export async function upsertThreadPlanningNote(
  context: UserWorkspaceContext,
  sessionId: string,
  input: UpsertThreadPlanningNotesInput,
) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("thread_planning_notes")
    .upsert(
      {
        workspace_id: context.workspaceId,
        session_id: sessionId,
        content: input.content,
        updated_by: context.userId,
      },
      { onConflict: "workspace_id,session_id" },
    )
    .select("*")
    .single();
  if (error) throw mapDatabaseError(error);
  return { note: data };
}

/**
 * 项目工作目录变更后，把按路径共享的项目规划笔记迁到新的 project_ref。
 * 目标位置已存在笔记时保留两者中最近更新的一份，避免静默覆盖用户内容。
 */
export async function migrateProjectPlanningNote(
  context: UserWorkspaceContext,
  previousWorkingDirectory: string,
  nextWorkingDirectory: string,
): Promise<void> {
  if (previousWorkingDirectory === nextWorkingDirectory) return;
  const previousRef = `path:${previousWorkingDirectory}`;
  const nextRef = `path:${nextWorkingDirectory}`;
  const admin = createAdminClient();

  const { data: previous, error: previousError } = await admin
    .from("planning_notes")
    .select("content, updated_at, updated_by")
    .eq("workspace_id", context.workspaceId)
    .eq("project_ref", previousRef)
    .maybeSingle();
  if (previousError) throw mapDatabaseError(previousError);
  if (!previous) return;

  const { data: existing, error: existingError } = await admin
    .from("planning_notes")
    .select("content, updated_at, updated_by")
    .eq("workspace_id", context.workspaceId)
    .eq("project_ref", nextRef)
    .maybeSingle();
  if (existingError) throw mapDatabaseError(existingError);

  const previousIsNewer =
    !existing ||
    Date.parse(previous.updated_at) > Date.parse(existing.updated_at);
  if (!existing || previousIsNewer) {
    const { error } = await admin
      .from("planning_notes")
      .update(
        existing
          ? {
              content: previous.content,
              updated_by: previous.updated_by,
            }
          : { project_ref: nextRef },
      )
      .eq("workspace_id", context.workspaceId)
      .eq("project_ref", existing ? nextRef : previousRef);
    if (error) throw mapDatabaseError(error);
  }

  if (existing) {
    const { error } = await admin
      .from("planning_notes")
      .delete()
      .eq("workspace_id", context.workspaceId)
      .eq("project_ref", previousRef);
    if (error) throw mapDatabaseError(error);
  }
}

async function requireTurnPlanStep(
  context: UserWorkspaceContext,
  stepId: string,
): Promise<SessionTurnPlanRow> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("session_turn_plans")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("id", stepId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!data) throw new AppError("TASK_NOT_FOUND", "Turn plan step not found");
  return data;
}

export async function listTurnPlanSteps(
  context: UserWorkspaceContext,
  sessionId: string,
): Promise<{ steps: TurnPlanStep[] }> {
  const admin = createAdminClient();
  const { data: plans, error } = await admin
    .from("session_turn_plans")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("session_id", sessionId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw mapDatabaseError(error);

  const taskIds = [
    ...new Set(
      (plans ?? []).flatMap((plan) =>
        plan.dispatched_task_id ? [plan.dispatched_task_id] : [],
      ),
    ),
  ];
  const statusByTaskId = new Map<string, TaskStatus>();
  if (taskIds.length > 0) {
    const { data: tasks, error: tasksError } = await admin
      .from("tasks")
      .select("id, status")
      .eq("workspace_id", context.workspaceId)
      .in("id", taskIds);
    if (tasksError) throw mapDatabaseError(tasksError);
    for (const task of tasks ?? []) {
      statusByTaskId.set(task.id, task.status);
    }
  }

  return {
    steps: (plans ?? []).map((plan) => ({
      ...plan,
      dispatched_task_status: plan.dispatched_task_id
        ? (statusByTaskId.get(plan.dispatched_task_id) ?? null)
        : null,
    })),
  };
}

export async function createTurnPlanStep(
  context: UserWorkspaceContext,
  sessionId: string,
  input: CreateTurnPlanStepInput,
  idempotencyKey: string,
) {
  const admin = createAdminClient();
  const { data: last } = await admin
    .from("session_turn_plans")
    .select("position")
    .eq("workspace_id", context.workspaceId)
    .eq("session_id", sessionId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  // The derived id makes a client retry return the originally created step
  // instead of queuing the same prompt twice.
  const id = deriveStableUuid(
    `${context.workspaceId}\0${context.userId}\0turn-plan\0${idempotencyKey}`,
  );
  const row = {
    id,
    workspace_id: context.workspaceId,
    session_id: sessionId,
    position: (last?.position ?? 0) + 1024,
    content: input.content,
    model: input.model ?? null,
    reasoning_effort: input.reasoning_effort ?? null,
    created_by: context.userId,
  };
  const { data, error } = await admin
    .from("session_turn_plans")
    .insert(row)
    .select("*")
    .single();
  if (!error) return { step: data };
  if (error.code !== "23505") throw mapDatabaseError(error);

  const existing = await requireTurnPlanStep(context, id);
  return { step: existing };
}

export async function updateTurnPlanStep(
  context: UserWorkspaceContext,
  stepId: string,
  input: UpdateTurnPlanStepInput,
) {
  const existing = await requireTurnPlanStep(context, stepId);
  if (existing.status !== "draft") {
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      "Only draft turn plan steps can be edited",
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("session_turn_plans")
    .update({
      ...(input.content !== undefined ? { content: input.content } : null),
      ...(input.position !== undefined ? { position: input.position } : null),
      ...(input.model !== undefined ? { model: input.model } : null),
      ...(input.reasoning_effort !== undefined
        ? { reasoning_effort: input.reasoning_effort }
        : null),
    })
    .eq("workspace_id", context.workspaceId)
    .eq("id", stepId)
    .select("*")
    .single();
  if (error) throw mapDatabaseError(error);
  return { step: data };
}

export async function deleteTurnPlanStep(
  context: UserWorkspaceContext,
  stepId: string,
) {
  const existing = await requireTurnPlanStep(context, stepId);
  if (existing.status !== "draft") {
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      "Only draft turn plan steps can be deleted",
    );
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("session_turn_plans")
    .delete()
    .eq("workspace_id", context.workspaceId)
    .eq("id", stepId);
  if (error) throw mapDatabaseError(error);
  return { deleted: true as const };
}

export async function dispatchTurnPlanChain(
  context: UserWorkspaceContext,
  sessionId: string,
  idempotencyKey: string,
) {
  const admin = createAdminClient();
  // Titles follow the conversation composer's derivation so chained turns are
  // named exactly like manually sent ones. The RPC re-reads the drafts inside
  // its transaction, so a step removed in between simply keeps its SQL
  // fallback title.
  const { data: drafts, error } = await admin
    .from("session_turn_plans")
    .select("id, content")
    .eq("workspace_id", context.workspaceId)
    .eq("session_id", sessionId)
    .eq("status", "draft");
  if (error) throw mapDatabaseError(error);

  const titles = Object.fromEntries(
    (drafts ?? []).map((step) => [step.id, taskTitleFromPrompt(step.content)]),
  );
  return callDomainRpc("dispatch_session_turn_chain", {
    p_workspace_id: context.workspaceId,
    p_user_id: context.userId,
    p_session_id: sessionId,
    p_titles: titles,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest("dispatch_session_turn_chain", {
      sessionId,
      titles,
    }),
  });
}

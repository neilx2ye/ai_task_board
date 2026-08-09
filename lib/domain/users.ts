import "server-only";

import { createHash } from "node:crypto";

import {
  deriveConnectionToken,
  deriveStableUuid,
  hashRequest,
  hashToken,
} from "@/lib/auth/ai-token";
import type { UserWorkspaceContext } from "@/lib/auth/user";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import { callDomainRpc, type DomainFunctionArgs } from "@/lib/domain/rpc";
import {
  loadTaskRelations,
  SAFE_TASK_COLUMNS,
  sanitizeTask,
} from "@/lib/domain/tasks";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TaskStatus } from "@/lib/types/database";
import { safeFilename, safeMimeType } from "@/lib/validation/artifacts";
import type {
  CreateConnectionInput,
  CreateTaskInput,
  CreateUserSubtasksInput,
  ReplyToTaskInput,
  UpdateTaskInput,
} from "@/lib/validation/user";

type CommandMetadata = Pick<
  DomainFunctionArgs<"create_user_task">,
  "p_idempotency_key" | "p_request_hash"
>;

type UserContextParameters = Pick<
  DomainFunctionArgs<"create_user_task">,
  "p_workspace_id" | "p_user_id"
>;

function commandMetadata(
  operation: string,
  input: unknown,
  idempotencyKey: string,
): CommandMetadata {
  return {
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest(operation, input),
  };
}

function userContext(context: UserWorkspaceContext): UserContextParameters {
  return { p_workspace_id: context.workspaceId, p_user_id: context.userId };
}

export async function getWorkspace(context: UserWorkspaceContext) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspaces")
    .select("*")
    .eq("id", context.workspaceId)
    .single();
  if (error) throw mapDatabaseError(error);
  return {
    workspace: data,
    role: context.role,
    membership: { user_id: context.userId, role: context.role },
  };
}

export async function listUserTasks(
  context: UserWorkspaceContext,
  filters: { status?: string; root_task_id?: string; limit: number },
) {
  const admin = createAdminClient();
  let query = admin
    .from("tasks")
    .select(SAFE_TASK_COLUMNS)
    .eq("workspace_id", context.workspaceId)
    .order("priority", { ascending: false })
    .order("created_at")
    .limit(filters.limit);
  if (filters.root_task_id) query = query.eq("root_task_id", filters.root_task_id);
  if (filters.status) {
    const statuses = filters.status.split(",").map((status) => status.trim()).filter(Boolean);
    if (statuses.length) query = query.in("status", statuses as TaskStatus[]);
  }
  const { data, error } = await query;
  if (error) throw mapDatabaseError(error);
  const tasks = (data ?? []).map(sanitizeTask);
  const waitingTaskIds = tasks
    .filter((task) => task.status === "waiting_user")
    .map((task) => task.id);
  if (!waitingTaskIds.length) return { tasks, latest_ai_messages: [] };

  const { data: messages, error: messagesError } = await admin
    .from("task_messages")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("sender_type", "ai")
    .eq("requires_response", true)
    .is("read_at", null)
    .in("task_id", waitingTaskIds)
    .order("created_at", { ascending: false });
  if (messagesError) throw mapDatabaseError(messagesError);
  const seen = new Set<string>();
  const latestMessages = (messages ?? []).filter((message) => {
    if (seen.has(message.task_id)) return false;
    seen.add(message.task_id);
    return true;
  });
  return { tasks, latest_ai_messages: latestMessages };
}

export async function createUserTask(
  context: UserWorkspaceContext,
  input: CreateTaskInput,
  idempotencyKey: string,
) {
  const result = await callDomainRpc("create_user_task", {
    ...userContext(context),
    p_parent_task_id: input.parent_task_id ?? null,
    p_title: input.title,
    p_description: input.description ?? null,
    p_acceptance_criteria: input.acceptance_criteria ?? null,
    p_priority: input.priority,
    p_position: input.position ?? null,
    p_assigned_session_id: input.assigned_session_id,
    p_required_capabilities: input.required_capabilities,
    ...commandMetadata("create_user_task", input, idempotencyKey),
  });
  if (!result.task) throw new AppError("INTERNAL_ERROR", "Task creation returned no task");
  return result.task;
}

export async function getUserTask(context: UserWorkspaceContext, taskId: string) {
  const admin = createAdminClient();
  const { data: task, error } = await admin
    .from("tasks")
    .select(SAFE_TASK_COLUMNS)
    .eq("workspace_id", context.workspaceId)
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!task) throw new AppError("TASK_NOT_FOUND", "Task not found");

  const [details, sessionsResult] = await Promise.all([
    loadTaskRelations(context.workspaceId, task, true),
    admin
      .from("ai_sessions")
      .select("*")
      .eq("workspace_id", context.workspaceId)
      .order("last_seen_at", { ascending: false }),
  ]);
  if (sessionsResult.error) throw mapDatabaseError(sessionsResult.error);
  return { ...details, sessions: sessionsResult.data ?? [] };
}

export async function updateUserTask(
  context: UserWorkspaceContext,
  taskId: string,
  input: UpdateTaskInput,
  idempotencyKey: string,
) {
  const result = await callDomainRpc("update_user_task", {
    ...userContext(context),
    p_task_id: taskId,
    p_patch: input,
    ...commandMetadata("update_user_task", { taskId, ...input }, idempotencyKey),
  });
  if (!result.task) throw new AppError("INTERNAL_ERROR", "Task update returned no task");
  return result.task;
}

export async function createUserSubtasks(
  context: UserWorkspaceContext,
  taskId: string,
  input: CreateUserSubtasksInput,
  idempotencyKey: string,
) {
  const result = await callDomainRpc("create_user_subtasks", {
    ...userContext(context),
    p_parent_task_id: taskId,
    p_subtasks: input.subtasks,
    ...commandMetadata("create_user_subtasks", { taskId, ...input }, idempotencyKey),
  });
  const subtasks = Array.isArray(result.subtasks) ? result.subtasks : [];
  if (input.subtasks.length === 1) {
    if (!subtasks[0]) throw new AppError("INTERNAL_ERROR", "Subtask creation returned no task");
    return subtasks[0];
  }
  return result;
}

export async function replyToTask(
  context: UserWorkspaceContext,
  taskId: string,
  input: ReplyToTaskInput,
  idempotencyKey: string,
) {
  return callDomainRpc("reply_to_task", {
    ...userContext(context),
    p_task_id: taskId,
    p_content: input.content,
    p_reply_to_message_id: input.reply_to_message_id ?? null,
    ...commandMetadata("reply_to_task", { taskId, ...input }, idempotencyKey),
  });
}

export async function postUserTaskMessage(
  context: UserWorkspaceContext,
  taskId: string,
  input: ReplyToTaskInput,
  idempotencyKey: string,
) {
  return callDomainRpc("post_user_task_message", {
    ...userContext(context),
    p_task_id: taskId,
    p_content: input.content,
    p_reply_to_message_id: input.reply_to_message_id ?? null,
    ...commandMetadata("post_user_task_message", { taskId, ...input }, idempotencyKey),
  });
}

async function taskCommand(
  operation: "release_task_by_user" | "cancel_task" | "reopen_task",
  context: UserWorkspaceContext,
  taskId: string,
  reason: string | null,
  idempotencyKey: string,
) {
  return callDomainRpc(operation, {
    ...userContext(context),
    p_task_id: taskId,
    p_reason: reason,
    ...commandMetadata(operation, { taskId, reason }, idempotencyKey),
  });
}

export const releaseUserTask = taskCommand.bind(null, "release_task_by_user");
export const cancelUserTask = taskCommand.bind(null, "cancel_task");
export const reopenUserTask = taskCommand.bind(null, "reopen_task");

export async function listConnections(context: UserWorkspaceContext) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_connections")
    .select(
      "id, workspace_id, name, platform, created_by_user_id, last_used_at, created_at, revoked_at",
    )
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw mapDatabaseError(error);
  return { connections: data ?? [] };
}

export async function createConnection(
  context: UserWorkspaceContext,
  input: CreateConnectionInput,
  idempotencyKey: string,
) {
  const scope = `${context.workspaceId}\0${context.userId}\0create_connection\0${idempotencyKey}`;
  const token = deriveConnectionToken(scope);
  const connectionId = deriveStableUuid(scope);
  const result = await callDomainRpc("create_ai_connection", {
    ...userContext(context),
    p_connection_id: connectionId,
    p_name: input.name,
    p_platform: input.platform,
    p_token_hash: hashToken(token),
    ...commandMetadata("create_ai_connection", input, idempotencyKey),
  });
  if (!result.connection) {
    throw new AppError("INTERNAL_ERROR", "Connection creation returned no connection");
  }
  return { connection: result.connection, token };
}

export async function revokeConnection(
  context: UserWorkspaceContext,
  connectionId: string,
  idempotencyKey: string,
) {
  return callDomainRpc("revoke_ai_connection", {
    ...userContext(context),
    p_connection_id: connectionId,
    p_reason: null,
    ...commandMetadata("revoke_ai_connection", { connectionId, reason: null }, idempotencyKey),
  });
}

export async function rotateConnection(
  context: UserWorkspaceContext,
  connectionId: string,
  idempotencyKey: string,
) {
  const token = deriveConnectionToken(
    `${context.workspaceId}\0${context.userId}\0rotate_connection\0${connectionId}\0${idempotencyKey}`,
  );
  const result = await callDomainRpc("rotate_ai_connection", {
    ...userContext(context),
    p_connection_id: connectionId,
    p_token_hash: hashToken(token),
    ...commandMetadata("rotate_ai_connection", { connectionId }, idempotencyKey),
  });
  if (!result.connection) {
    throw new AppError("INTERNAL_ERROR", "Connection rotation returned no connection");
  }
  return { connection: result.connection, token };
}

export async function listSessions(context: UserWorkspaceContext) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_sessions")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("last_seen_at", { ascending: false });
  if (error) throw mapDatabaseError(error);
  return { sessions: data ?? [] };
}

export async function createArtifactDownload(
  context: UserWorkspaceContext,
  artifactId: string,
) {
  const admin = createAdminClient();
  const { data: artifact, error } = await admin
    .from("artifacts")
    .select("*")
    .eq("id", artifactId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!artifact) throw new AppError("TASK_NOT_FOUND", "Artifact not found");
  if (artifact.external_url) return { url: artifact.external_url, expires_in: null };
  if (!artifact.storage_path) {
    throw new AppError("INVALID_REQUEST", "Artifact does not have downloadable content");
  }
  const { data, error: storageError } = await admin.storage
    .from("task-artifacts")
    .createSignedUrl(artifact.storage_path, 60);
  if (storageError) throw new AppError("INTERNAL_ERROR", "Could not create download URL");
  return { url: data.signedUrl, expires_in: 60 };
}

function isStorageObjectAlreadyPresent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: number; statusCode?: string | number; message?: string };
  return (
    candidate.status === 409 ||
    String(candidate.statusCode ?? "") === "409" ||
    /already exists|duplicate/i.test(candidate.message ?? "")
  );
}

export async function uploadUserArtifact(
  context: UserWorkspaceContext,
  taskId: string,
  file: File,
  idempotencyKey: string,
) {
  const admin = createAdminClient();
  const { data: task, error: taskError } = await admin
    .from("tasks")
    .select("id")
    .eq("workspace_id", context.workspaceId)
    .eq("id", taskId)
    .maybeSingle();
  if (taskError) throw mapDatabaseError(taskError);
  if (!task) throw new AppError("TASK_NOT_FOUND", "Task not found");

  const bytes = Buffer.from(await file.arrayBuffer());
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const displayName =
    (file.name.normalize("NFKC").split(/[\\/]/).at(-1) ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 500) || "artifact";
  const mimeType = safeMimeType(file.type);
  const scope = `${context.workspaceId}\0${context.userId}\0${taskId}\0create_user_artifact\0${idempotencyKey}`;
  const artifactId = deriveStableUuid(scope);
  const storagePath = `${context.workspaceId}/${taskId}/${artifactId}-${safeFilename(displayName)}`;
  const requestInput = {
    task_id: taskId,
    name: displayName,
    mime_type: mimeType,
    size: bytes.byteLength,
    storage_path: storagePath,
    content_sha256: contentHash,
  };

  const { error: uploadError } = await admin.storage
    .from("task-artifacts")
    .upload(storagePath, bytes, { contentType: mimeType, upsert: false });
  const uploadedByThisRequest = !uploadError;
  if (uploadError && !isStorageObjectAlreadyPresent(uploadError)) {
    throw new AppError("INTERNAL_ERROR", "Artifact upload failed");
  }

  try {
    const result = await callDomainRpc("create_user_artifact", {
      ...userContext(context),
      p_task_id: taskId,
      p_artifact_id: artifactId,
      p_name: displayName,
      p_mime_type: mimeType,
      p_size: bytes.byteLength,
      p_storage_path: storagePath,
      ...commandMetadata("create_user_artifact", requestInput, idempotencyKey),
    });
    if (!result.artifact) {
      throw new AppError("INTERNAL_ERROR", "Artifact creation returned no artifact");
    }
    return result.artifact;
  } catch (error) {
    if (uploadedByThisRequest) {
      // Resolve ambiguous RPC/network failures before compensating: a committed
      // row is authoritative, while an unreferenced object is safe to remove.
      const { data: committedArtifact, error: lookupError } = await admin
        .from("artifacts")
        .select("storage_path")
        .eq("workspace_id", context.workspaceId)
        .eq("id", artifactId)
        .maybeSingle();
      if (!lookupError && committedArtifact?.storage_path !== storagePath) {
        await admin.storage.from("task-artifacts").remove([storagePath]).catch(() => undefined);
      }
    }
    throw error;
  }
}

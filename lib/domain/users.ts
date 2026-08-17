import "server-only";

import { createHash } from "node:crypto";

import {
  deriveConnectionToken,
  deriveStableUuid,
  hashRequest,
  hashToken,
} from "@/lib/auth/ai-token";
import type { UserWorkspaceContext } from "@/lib/auth/user";
import { parseCodexModelCatalog } from "@/lib/codex-models";
import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import {
  chunkValues,
  collectChunkedRows,
  collectRangePages,
} from "@/lib/domain/postgrest-pagination";
import { callDomainRpc, type DomainFunctionArgs } from "@/lib/domain/rpc";
import {
  loadTaskRelations,
  SAFE_TASK_COLUMNS,
  SAFE_TASK_USER_INPUT_REQUEST_COLUMNS,
  sanitizeTask,
} from "@/lib/domain/tasks";
import { taskTitleFromPrompt } from "@/lib/domain/task-title";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  SessionActivityItem,
  SessionCurrentTaskSummary,
  SessionListItem,
} from "@/lib/types/domain";
import type {
  AIThreadCommandRow,
  AISessionRow,
  TaskEventRow,
  TaskMessageRow,
  TaskRow,
  TaskStatus,
} from "@/lib/types/database";
import { safeFilename, safeMimeType } from "@/lib/validation/artifacts";
import type {
  CreateConnectionInput,
  CreateThreadInput,
  CreateSessionTurnInput,
  CreateTaskInput,
  CreateUserSubtasksInput,
  RenameConnectionInput,
  RenameThreadInput,
  ReplyToTaskInput,
  AnswerTaskUserInputRequestInput,
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

const SESSION_CARD_TASK_COLUMNS =
  "id, title, status, progress_note, progress_percent_estimate, updated_at, assigned_session_id, awaiting_user_input" as const;

function sessionTaskSummary(
  task: Pick<
    TaskRow,
    | "id"
    | "title"
    | "status"
    | "progress_note"
    | "progress_percent_estimate"
    | "updated_at"
    | "awaiting_user_input"
  >,
): SessionCurrentTaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    progress_note: task.progress_note,
    progress_percent_estimate: task.progress_percent_estimate,
    updated_at: task.updated_at,
    awaiting_user_input: task.awaiting_user_input,
  };
}

type AdminClient = ReturnType<typeof createAdminClient>;

function isMissingModelCatalogSchema(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): boolean {
  if (
    error.code !== "PGRST204" &&
    error.code !== "42703" &&
    error.code !== "42P01"
  ) {
    return false;
  }
  return [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ")
    .includes("model_catalog");
}

function isMissingQuotaSchema(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): boolean {
  if (
    error.code !== "PGRST204" &&
    error.code !== "42703" &&
    error.code !== "42P01"
  ) {
    return false;
  }
  return [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ")
    .includes("quota");
}

function isMissingDeviceSchema(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): boolean {
  if (
    error.code !== "PGRST204" &&
    error.code !== "42703" &&
    error.code !== "42P01"
  ) {
    return false;
  }
  const source = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ");
  return (
    source.includes("device_id") ||
    source.includes("device_label") ||
    source.includes("desired_bridge_version")
  );
}

async function loadConnectionModelSettings(
  admin: AdminClient,
  workspaceId: string,
  connectionIds: readonly string[],
) {
  return collectChunkedRows(connectionIds, async (ids) => {
    let { data, error } = await admin
      .from("ai_connection_bridge_settings")
      .select(
        "connection_id, model_catalog, model_catalog_updated_at, quota, quota_updated_at, device_id, device_label, desired_bridge_version",
      )
      .eq("workspace_id", workspaceId)
      .in("connection_id", [...ids]);
    if (error && isMissingDeviceSchema(error)) {
      // 滚动部署：设备标识/期望版本迁移可能落后于 Web 发布，先退回旧查询。
      const fallback = await admin
        .from("ai_connection_bridge_settings")
        .select(
          "connection_id, model_catalog, model_catalog_updated_at, quota, quota_updated_at",
        )
        .eq("workspace_id", workspaceId)
        .in("connection_id", [...ids]);
      data = fallback.data
        ? fallback.data.map((row) => ({
            ...row,
            device_id: null,
            device_label: null,
            desired_bridge_version: null,
          }))
        : null;
      error = fallback.error;
    }
    if (error && !isMissingModelCatalogSchema(error)) {
      if (isMissingQuotaSchema(error)) {
        const legacy = await admin
          .from("ai_connection_bridge_settings")
          .select("connection_id, model_catalog, model_catalog_updated_at")
          .eq("workspace_id", workspaceId)
          .in("connection_id", [...ids]);
        if (legacy.error) throw mapDatabaseError(legacy.error);
        return (legacy.data ?? []).map((row) => ({
          ...row,
          quota: null,
          quota_updated_at: null,
          device_id: null,
          device_label: null,
          desired_bridge_version: null,
        }));
      }
      throw mapDatabaseError(error);
    }
    return data ?? [];
  });
}

type ThreadSettingsCommand = Pick<
  AIThreadCommandRow,
  | "id"
  | "external_thread_id"
  | "model"
  | "reasoning_effort"
  | "status"
  | "created_at"
>;

type ThreadSettings = {
  model: string | null;
  reasoningEffort: string | null;
  status: SessionListItem["thread_settings_status"];
};

function mergeThreadSettingsStatus(
  current: ThreadSettings["status"],
  incoming: ThreadSettingsCommand["status"],
): ThreadSettings["status"] {
  if (incoming === "failed") return current;
  if (current === "running" || incoming === "running") return "running";
  if (current === "queued" || incoming === "queued") return "queued";
  return "succeeded";
}

function threadSettingsByExternalRef(
  commands: readonly ThreadSettingsCommand[],
): Map<string, ThreadSettings> {
  const settingsByRef = new Map<string, ThreadSettings>();
  for (const command of commands) {
    const externalRef = command.external_thread_id;
    if (!externalRef || (!command.model && !command.reasoning_effort)) continue;

    const settings = settingsByRef.get(externalRef) ?? {
      model: null,
      reasoningEffort: null,
      status: null,
    };
    let contributed = false;
    if (!settings.model && command.model) {
      settings.model = command.model;
      contributed = true;
    }
    if (!settings.reasoningEffort && command.reasoning_effort) {
      settings.reasoningEffort = command.reasoning_effort;
      contributed = true;
    }
    if (contributed) {
      settings.status = mergeThreadSettingsStatus(
        settings.status,
        command.status,
      );
      settingsByRef.set(externalRef, settings);
    }
  }
  return settingsByRef;
}

async function loadSessionListItems(
  admin: AdminClient,
  workspaceId: string,
  sessions: AISessionRow[],
): Promise<SessionListItem[]> {
  if (!sessions.length) return [];

  const connectionIds = [...new Set(sessions.map((session) => session.connection_id))];
  const currentTaskIds = [
    ...new Set(
      sessions
        .map((session) => session.current_task_id)
        .filter((taskId): taskId is string => Boolean(taskId)),
    ),
  ];
  const sessionIds = sessions.map((session) => session.id);
  const externalThreadRefs = [
    ...new Set(
      sessions.flatMap((session) =>
        session.external_conversation_ref
          ? [session.external_conversation_ref]
          : [],
      ),
    ),
  ];
  const [
    connections,
    connectionSettings,
    currentTasks,
    pendingTasks,
    threadSettingCommands,
  ] =
    await Promise.all([
    collectChunkedRows(connectionIds, async (ids) => {
      const { data, error } = await admin
        .from("ai_connections")
        .select("id, name, platform, last_seen_at, bridge_version, revoked_at")
        .eq("workspace_id", workspaceId)
        .in("id", [...ids]);
      if (error) throw mapDatabaseError(error);
      return data ?? [];
    }),
    loadConnectionModelSettings(admin, workspaceId, connectionIds),
    collectChunkedRows(currentTaskIds, async (ids) => {
      const { data, error } = await admin
        .from("tasks")
        .select(SESSION_CARD_TASK_COLUMNS)
        .eq("workspace_id", workspaceId)
        .in("id", [...ids]);
      if (error) throw mapDatabaseError(error);
      return data ?? [];
    }),
    collectChunkedRows(sessionIds, (ids) =>
      collectRangePages(async (from, to) => {
        const { data, error } = await admin
          .from("tasks")
          .select(SESSION_CARD_TASK_COLUMNS)
          .eq("workspace_id", workspaceId)
          .in("status", ["ready", "waiting_user"])
          .in("assigned_session_id", [...ids])
          .order("priority", { ascending: false })
          .order("created_at")
          .order("id")
          .range(from, to);
        if (error) throw mapDatabaseError(error);
        return data ?? [];
      }),
    ),
    collectChunkedRows(externalThreadRefs, (externalRefs) =>
      collectRangePages(async (from, to) => {
        const { data, error } = await admin
          .from("ai_thread_commands")
          .select(
            "id, external_thread_id, model, reasoning_effort, status, created_at",
          )
          .eq("workspace_id", workspaceId)
          .in("external_thread_id", [...externalRefs])
          .in("action", ["create", "rename"])
          .in("status", ["queued", "running", "succeeded"])
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to);
        if (error) throw mapDatabaseError(error);
        return data ?? [];
      }),
    ),
  ]);

  const connectionById = new Map(
    connections.map((connection) => [connection.id, connection]),
  );
  const connectionSettingsById = new Map(
    connectionSettings.map((settings) => [settings.connection_id, settings]),
  );
  const currentTaskById = new Map(
    currentTasks.map((task) => [task.id, sessionTaskSummary(task)]),
  );
  const queuedCountBySession = new Map<string, number>();
  const waitingTaskBySession = new Map<string, SessionCurrentTaskSummary>();
  const nextTaskBySession = new Map<string, SessionCurrentTaskSummary>();
  const threadSettings = threadSettingsByExternalRef(threadSettingCommands);
  for (const row of pendingTasks) {
    if (!row.assigned_session_id) continue;
    if (row.status === "ready") {
      queuedCountBySession.set(
        row.assigned_session_id,
        (queuedCountBySession.get(row.assigned_session_id) ?? 0) + 1,
      );
      if (!nextTaskBySession.has(row.assigned_session_id)) {
        nextTaskBySession.set(row.assigned_session_id, sessionTaskSummary(row));
      }
    } else if (!waitingTaskBySession.has(row.assigned_session_id)) {
      waitingTaskBySession.set(row.assigned_session_id, sessionTaskSummary(row));
    }
  }

  return sessions.map((session): SessionListItem => {
    const connection = connectionById.get(session.connection_id);
    const currentTask = session.current_task_id
      ? currentTaskById.get(session.current_task_id)
      : undefined;
    const settings = session.external_conversation_ref
      ? threadSettings.get(session.external_conversation_ref)
      : undefined;
    const connectionModelSettings = connectionSettingsById.get(
      session.connection_id,
    );
    return {
      ...session,
      status: currentTask?.awaiting_user_input ? "waiting" : session.status,
      name: session.user_name ?? session.name,
      connection: connection
        ? {
            ...connection,
            model_catalog: parseCodexModelCatalog(
              connectionModelSettings?.model_catalog,
            ),
            model_catalog_updated_at:
              connectionModelSettings?.model_catalog_updated_at ?? null,
          }
        : {
            id: session.connection_id,
            name: "已撤销的连接",
            platform: session.platform,
            last_seen_at: null,
            bridge_version: null,
            revoked_at: new Date(0).toISOString(),
            model_catalog: null,
            model_catalog_updated_at: null,
          },
      current_task:
        currentTask ??
        waitingTaskBySession.get(session.id) ??
        nextTaskBySession.get(session.id) ??
        null,
      queued_task_count: queuedCountBySession.get(session.id) ?? 0,
      configured_model: settings?.model ?? null,
      configured_reasoning_effort: settings?.reasoningEffort ?? null,
      thread_settings_status: settings?.status ?? null,
    };
  });
}

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
    .filter(
      (task) => task.status === "waiting_user" || task.awaiting_user_input,
    )
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

export async function answerTaskUserInputRequest(
  context: UserWorkspaceContext,
  taskId: string,
  requestId: string,
  input: AnswerTaskUserInputRequestInput,
  idempotencyKey: string,
) {
  return callDomainRpc("answer_task_user_input_request", {
    ...userContext(context),
    p_task_id: taskId,
    p_request_id: requestId,
    p_answers: input.answers,
    ...commandMetadata(
      "answer_task_user_input_request",
      { taskId, requestId, ...input },
      idempotencyKey,
    ),
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
      "id, workspace_id, name, platform, created_by_user_id, last_used_at, last_seen_at, bridge_version, created_at, revoked_at",
    )
    .eq("workspace_id", context.workspaceId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw mapDatabaseError(error);
  const connections = data ?? [];
  const settings = await loadConnectionModelSettings(
    admin,
    context.workspaceId,
    connections.map((connection) => connection.id),
  );
  const settingsByConnectionId = new Map(
    settings.map((row) => [row.connection_id, row]),
  );
  return {
    connections: connections.map((connection) => {
      const modelSettings = settingsByConnectionId.get(connection.id);
      return {
        ...connection,
        model_catalog: parseCodexModelCatalog(modelSettings?.model_catalog),
        model_catalog_updated_at:
          modelSettings?.model_catalog_updated_at ?? null,
        quota: modelSettings?.quota ?? null,
        quota_updated_at: modelSettings?.quota_updated_at ?? null,
        device_id: modelSettings?.device_id ?? null,
        device_label: modelSettings?.device_label ?? null,
        desired_bridge_version: modelSettings?.desired_bridge_version ?? null,
      };
    }),
  };
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

export async function renameConnection(
  context: UserWorkspaceContext,
  connectionId: string,
  input: RenameConnectionInput,
  idempotencyKey: string,
) {
  return callDomainRpc("rename_ai_connection", {
    ...userContext(context),
    p_connection_id: connectionId,
    p_name: input.name,
    ...commandMetadata(
      "rename_ai_connection",
      { connectionId, ...input },
      idempotencyKey,
    ),
  });
}

async function enqueueThreadCommand(
  context: UserWorkspaceContext,
  input: {
    connectionId: string;
    sessionId: string | null;
    action: "create" | "rename" | "delete";
    name: string | null;
    directoryKey: string | null;
    model: string | null;
    reasoningEffort: string | null;
  },
  idempotencyKey: string,
) {
  const scope = `${context.workspaceId}\0${context.userId}\0enqueue_ai_thread_command\0${idempotencyKey}`;
  return callDomainRpc("enqueue_ai_thread_command_with_settings", {
    ...userContext(context),
    p_command_id: deriveStableUuid(scope),
    p_connection_id: input.connectionId,
    p_session_id: input.sessionId,
    p_action: input.action,
    p_name: input.name,
    p_directory_key: input.directoryKey,
    p_model: input.model,
    p_reasoning_effort: input.reasoningEffort,
    ...commandMetadata(
      "enqueue_ai_thread_command_with_settings",
      input,
      idempotencyKey,
    ),
  });
}

export function createThread(
  context: UserWorkspaceContext,
  connectionId: string,
  input: CreateThreadInput,
  idempotencyKey: string,
) {
  return enqueueThreadCommand(
    context,
    {
      connectionId,
      sessionId: null,
      action: "create",
      name: input.name,
      directoryKey: input.directory_key ?? null,
      model: input.model ?? null,
      reasoningEffort: input.reasoning_effort ?? null,
    },
    idempotencyKey,
  );
}

async function sessionConnectionId(
  context: UserWorkspaceContext,
  sessionId: string,
): Promise<string> {
  const { data, error } = await createAdminClient()
    .from("ai_sessions")
    .select("connection_id")
    .eq("workspace_id", context.workspaceId)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!data) {
    throw new AppError("SESSION_NOT_AUTHORIZED", "Session not found");
  }
  return data.connection_id;
}

export async function renameThread(
  context: UserWorkspaceContext,
  sessionId: string,
  input: RenameThreadInput,
  idempotencyKey: string,
) {
  const connectionId = await sessionConnectionId(context, sessionId);
  return enqueueThreadCommand(
    context,
    {
      connectionId,
      sessionId,
      action: "rename",
      name: input.name,
      directoryKey: null,
      model: input.model ?? null,
      reasoningEffort: input.reasoning_effort ?? null,
    },
    idempotencyKey,
  );
}

export async function deleteThread(
  context: UserWorkspaceContext,
  sessionId: string,
  idempotencyKey: string,
) {
  const connectionId = await sessionConnectionId(context, sessionId);
  return enqueueThreadCommand(
    context,
    {
      connectionId,
      sessionId,
      action: "delete",
      name: null,
      directoryKey: null,
      model: null,
      reasoningEffort: null,
    },
    idempotencyKey,
  );
}

export async function listSessions(context: UserWorkspaceContext) {
  const admin = createAdminClient();
  const sessions = await collectRangePages(async (from, to) => {
    const { data, error } = await admin
      .from("ai_sessions")
      .select("*")
      .eq("workspace_id", context.workspaceId)
      .is("deletion_requested_at", null)
      // Offset pagination must use immutable ordering columns. Heartbeats
      // continuously update last_seen_at and would otherwise move rows across
      // page boundaries while a multi-page snapshot is being collected.
      .order("created_at")
      .order("id")
      .range(from, to);
    if (error) throw mapDatabaseError(error);
    return data ?? [];
  });
  const items = await loadSessionListItems(
    admin,
    context.workspaceId,
    sessions,
  );
  items.sort((left, right) => {
    const byLastSeen = (right.last_seen_at ?? "").localeCompare(
      left.last_seen_at ?? "",
    );
    if (byLastSeen) return byLastSeen;
    const byCreated = right.created_at.localeCompare(left.created_at);
    return byCreated || right.id.localeCompare(left.id);
  });
  return { sessions: items };
}

type ActivityCursor = {
  occurredAt: string;
  sourceOrder: string;
  id: string;
};

const POSITIVE_BIGINT = /^[1-9][0-9]{0,18}$/;
const NONNEGATIVE_BIGINT = /^(0|[1-9][0-9]{0,18})$/;
const MAX_BIGINT_TEXT = "9223372036854775807";
const ISO_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

function validBigintText(value: string, allowZero: boolean) {
  const expression = allowZero ? NONNEGATIVE_BIGINT : POSITIVE_BIGINT;
  return (
    expression.test(value) &&
    (value.length < 19 || value <= MAX_BIGINT_TEXT)
  );
}

/** Opaque, lossless boundary for the timeline's total ordering. */
export function encodeSessionActivityCursor(
  activity: Pick<SessionActivityItem, "occurred_at" | "source_order" | "id">,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      t: activity.occurred_at,
      o: activity.source_order,
      i: activity.id,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeSessionActivityCursor(value: string): ActivityCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("not an object");
    }
    const cursor = decoded as Record<string, unknown>;
    if (
      Object.keys(cursor).length !== 4 ||
      cursor.v !== 1 ||
      typeof cursor.t !== "string" ||
      !ISO_TIMESTAMP.test(cursor.t) ||
      !Number.isFinite(Date.parse(cursor.t)) ||
      typeof cursor.o !== "string" ||
      !validBigintText(cursor.o, true) ||
      typeof cursor.i !== "string" ||
      !validBigintText(cursor.i, false)
    ) {
      throw new Error("invalid fields");
    }
    return {
      occurredAt: cursor.t,
      sourceOrder: cursor.o,
      id: cursor.i,
    };
  } catch {
    throw new AppError("INVALID_REQUEST", "The activity cursor is invalid");
  }
}

export async function getSessionConversation(
  context: UserWorkspaceContext,
  sessionId: string,
  page: {
    beforeActivityCursor?: string;
    beforeActivityId?: string;
    limit: number;
  } = { limit: 100 },
) {
  const admin = createAdminClient();
  const { data: sessionRow, error: sessionError } = await admin
    .from("ai_sessions")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("id", sessionId)
    .is("deletion_requested_at", null)
    .maybeSingle();
  if (sessionError) throw mapDatabaseError(sessionError);
  if (!sessionRow) {
    throw new AppError("SESSION_NOT_AUTHORIZED", "Session not found");
  }
  const [session] = await loadSessionListItems(admin, context.workspaceId, [sessionRow]);
  if (!session) {
    throw new AppError("SESSION_NOT_AUTHORIZED", "Session not found");
  }

  let cursor = page.beforeActivityCursor
    ? decodeSessionActivityCursor(page.beforeActivityCursor)
    : undefined;
  if (!cursor && page.beforeActivityId) {
    const { data: legacyBoundary, error: boundaryError } = await admin
      .from("session_activities")
      .select("id, occurred_at, source_order")
      .eq("workspace_id", context.workspaceId)
      .eq("session_id", sessionId)
      .filter("id", "eq", page.beforeActivityId)
      .maybeSingle();
    if (boundaryError) throw mapDatabaseError(boundaryError);
    if (!legacyBoundary) {
      throw new AppError("INVALID_REQUEST", "The activity cursor is invalid");
    }
    cursor = {
      occurredAt: legacyBoundary.occurred_at,
      sourceOrder: String(legacyBoundary.source_order),
      id: String(legacyBoundary.id),
    };
  }

  const activityQuery = admin
    .from("session_activities")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("session_id", sessionId)
    .order("occurred_at", { ascending: false })
    .order("source_order", { ascending: false })
    .order("id", { ascending: false })
    .limit(page.limit + 1);
  if (cursor) {
    activityQuery.or(
      `occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},source_order.lt.${cursor.sourceOrder}),and(occurred_at.eq.${cursor.occurredAt},source_order.eq.${cursor.sourceOrder},id.lt.${cursor.id})`,
    );
  }

  // Legacy task/message/event context is a compatibility bootstrap, not part
  // of every backwards activity page. Repeating it for each page multiplies
  // payload and database work while adding no new history.
  const includeLegacy = cursor === undefined;
  // Legacy rows bootstrap conversations created before session_activities.
  // Keep this compatibility payload deliberately bounded; new App Server
  // history is independently cursor-paginated above.
  const legacyLimit = 250;
  const [
    activitiesResult,
    historySyncResult,
    rawOwnedTasks,
    rawActorEvents,
  ] = await Promise.all([
    activityQuery,
    admin
      .from("session_history_syncs")
      .select("*")
      .eq("workspace_id", context.workspaceId)
      .eq("session_id", sessionId)
      .maybeSingle(),
    includeLegacy
      ? collectRangePages(
          async (from, to) => {
            const { data, error } = await admin
              .from("tasks")
              .select(SAFE_TASK_COLUMNS)
              .eq("workspace_id", context.workspaceId)
              .or(
                `assigned_session_id.eq.${sessionId},claimed_by_session_id.eq.${sessionId},and(created_by_type.eq.ai,created_by_id.eq.${sessionId})`,
              )
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
              .range(from, to);
            if (error) throw mapDatabaseError(error);
            return data ?? [];
          },
          { maxRows: legacyLimit + 1 },
        )
      : Promise.resolve([] as TaskRow[]),
    includeLegacy
      ? collectRangePages(
          async (from, to) => {
            const { data, error } = await admin
              .from("task_events")
              .select("task_id")
              .eq("workspace_id", context.workspaceId)
              .eq("actor_type", "ai")
              .eq("actor_id", sessionId)
              .order("id", { ascending: false })
              .range(from, to);
            if (error) throw mapDatabaseError(error);
            return data ?? [];
          },
          { maxRows: legacyLimit + 1 },
        )
      : Promise.resolve([] as Array<{ task_id: string }>),
  ]);
  if (activitiesResult.error) throw mapDatabaseError(activitiesResult.error);
  if (historySyncResult.error) throw mapDatabaseError(historySyncResult.error);

  const rawActivities = activitiesResult.data ?? [];
  const hasMoreOlder = rawActivities.length > page.limit;
  const activities = rawActivities
    .slice(0, page.limit)
    .reverse()
    .map(
      (activity): SessionActivityItem => ({
        ...activity,
        id: String(activity.id),
        source_order: String(activity.source_order),
      }),
    );
  const historySync = historySyncResult.data
    ? {
        status: historySyncResult.data.status,
        turn_limit: historySyncResult.data.turn_limit,
        scanned_turns: historySyncResult.data.scanned_turns,
        total_turns: historySyncResult.data.total_turns,
        imported_items: historySyncResult.data.imported_items,
        next_cursor: historySyncResult.data.next_cursor,
        error: historySyncResult.data.error,
        started_at: historySyncResult.data.started_at,
        completed_at: historySyncResult.data.completed_at,
        updated_at: historySyncResult.data.updated_at,
      }
    : null;
  let tasksTruncated =
    rawOwnedTasks.length > legacyLimit || rawActorEvents.length > legacyLimit;
  const tasksById = new Map<string, TaskRow>();
  for (const task of rawOwnedTasks.slice(0, legacyLimit)) {
    tasksById.set(task.id, sanitizeTask(task));
  }
  const historicalTaskIds = new Set([
    ...activities.flatMap((activity) =>
      activity.task_id ? [activity.task_id] : [],
    ),
    ...rawActorEvents.slice(0, legacyLimit).map((event) => event.task_id),
  ]);
  const activityTaskIds = [...new Set(activities.flatMap((activity) =>
    activity.task_id ? [activity.task_id] : [],
  ))];
  const activityArtifacts = activityTaskIds.length
    ? await collectChunkedRows(activityTaskIds, async (taskIds) => {
        const { data, error } = await admin
          .from("artifacts")
          .select("*")
          .eq("workspace_id", context.workspaceId)
          .in("task_id", [...taskIds])
          .order("created_at");
        if (error) throw mapDatabaseError(error);
        return data ?? [];
      })
    : [];
  const missingTaskIds = [...historicalTaskIds].filter((taskId) => !tasksById.has(taskId));
  if (missingTaskIds.length) {
    const historicalTasks = await collectChunkedRows(
      missingTaskIds,
      async (taskIds) => {
        const { data, error } = await admin
          .from("tasks")
          .select(SAFE_TASK_COLUMNS)
          .eq("workspace_id", context.workspaceId)
          .in("id", [...taskIds]);
        if (error) throw mapDatabaseError(error);
        return data ?? [];
      },
    );
    for (const task of historicalTasks) {
      tasksById.set(task.id, sanitizeTask(task));
    }
  }

  const newestTasks = [...tasksById.values()].sort((left, right) => {
    const byTime = right.created_at.localeCompare(left.created_at);
    return byTime || right.id.localeCompare(left.id);
  });
  tasksTruncated ||= newestTasks.length > legacyLimit;
  const legacyTasks = newestTasks.slice(0, legacyLimit);
  const taskIds = legacyTasks.map((task) => task.id);
  if (!taskIds.length) {
    return {
      session,
      tasks: [],
      messages: [],
      input_requests: [],
      events: [],
      activities,
      artifacts: activityArtifacts,
      history_sync: historySync,
      pagination: {
        activities: {
          limit: page.limit,
          oldest_cursor: activities[0]
            ? encodeSessionActivityCursor(activities[0])
            : null,
          newest_cursor: activities.at(-1)
            ? encodeSessionActivityCursor(activities.at(-1)!)
            : null,
          has_more_older: hasMoreOlder,
        },
        legacy: {
          limit: legacyLimit,
          tasks_truncated: tasksTruncated,
          messages_truncated: false,
          events_truncated: false,
        },
      },
    };
  }
  let newestMessages: TaskMessageRow[] = [];
  let newestEvents: TaskEventRow[] = [];
  const inputRequests = includeLegacy
    ? await collectChunkedRows(taskIds, async (taskIdBatch) => {
        const { data, error } = await admin
          .from("task_user_input_requests")
          .select(SAFE_TASK_USER_INPUT_REQUEST_COLUMNS)
          .eq("workspace_id", context.workspaceId)
          .eq("session_id", sessionId)
          .eq("status", "pending")
          .in("task_id", [...taskIdBatch])
          .order("created_at");
        if (error) throw mapDatabaseError(error);
        return data ?? [];
      })
    : [];
  if (includeLegacy) {
    for (const taskIdBatch of chunkValues(taskIds)) {
      const [batchMessages, batchEvents] = await Promise.all([
        collectRangePages(
          async (from, to) => {
            const { data, error } = await admin
              .from("task_messages")
              .select("*")
              .eq("workspace_id", context.workspaceId)
              .in("task_id", taskIdBatch)
              .or(`sender_type.neq.ai,sender_id.eq.${sessionId}`)
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
              .range(from, to);
            if (error) throw mapDatabaseError(error);
            return data ?? [];
          },
          { maxRows: legacyLimit + 1 },
        ),
        collectRangePages(
          async (from, to) => {
            const { data, error } = await admin
              .from("task_events")
              .select("*")
              .eq("workspace_id", context.workspaceId)
              .in("task_id", taskIdBatch)
              .or(`actor_type.neq.ai,actor_id.eq.${sessionId}`)
              .order("id", { ascending: false })
              .range(from, to);
            if (error) throw mapDatabaseError(error);
            return data ?? [];
          },
          { maxRows: legacyLimit + 1 },
        ),
      ]);
      // Each .in() batch has its own ordered range. Merge and prune after every
      // batch so memory stays bounded while retaining the global newest rows.
      newestMessages = [...newestMessages, ...batchMessages]
        .sort((left, right) => {
          const byTime = right.created_at.localeCompare(left.created_at);
          return byTime || right.id.localeCompare(left.id);
        })
        .slice(0, legacyLimit + 1);
      newestEvents = [...newestEvents, ...batchEvents]
        .sort((left, right) => right.id - left.id)
        .slice(0, legacyLimit + 1);
    }
  }
  return {
    session,
    tasks: legacyTasks.sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    ),
    // Legacy task rows are not intrinsically session-scoped. Keep user/system
    // context, but do not attribute another AI session's output to this one.
    messages: newestMessages.slice(0, legacyLimit).reverse(),
    input_requests: inputRequests,
    events: newestEvents.slice(0, legacyLimit).reverse(),
    activities,
    artifacts: activityArtifacts,
    history_sync: historySync,
    pagination: {
      activities: {
        limit: page.limit,
        oldest_cursor: activities[0]
          ? encodeSessionActivityCursor(activities[0])
          : null,
        newest_cursor: activities.at(-1)
          ? encodeSessionActivityCursor(activities.at(-1)!)
          : null,
        has_more_older: hasMoreOlder,
      },
      legacy: {
        limit: legacyLimit,
        tasks_truncated: tasksTruncated,
        messages_truncated: newestMessages.length > legacyLimit,
        events_truncated: newestEvents.length > legacyLimit,
      },
    },
  };
}

export async function createSessionTurn(
  context: UserWorkspaceContext,
  sessionId: string,
  input: CreateSessionTurnInput & { images?: File[] },
  idempotencyKey: string,
) {
  const title = taskTitleFromPrompt(input.content);
  const admin = createAdminClient();
  const uploadedPaths: string[] = [];
  const images = [];
  for (const [index, file] of (input.images ?? []).entries()) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = deriveStableUuid(
      `${context.workspaceId}\0${context.userId}\0${sessionId}\0${idempotencyKey}\0${index}\0${sha256}`,
    );
    const name =
      (file.name.normalize("NFKC").split(/[\\/]/).at(-1) ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 500) || `image-${index + 1}`;
    const mimeType = safeMimeType(file.type);
    const storagePath = `${context.workspaceId}/turn-images/${id}-${safeFilename(name)}`;
    const { error } = await admin.storage
      .from("task-artifacts")
      .upload(storagePath, bytes, { contentType: mimeType, upsert: false });
    if (error && !isStorageObjectAlreadyPresent(error)) {
      if (uploadedPaths.length) {
        await admin.storage.from("task-artifacts").remove(uploadedPaths).catch(() => undefined);
      }
      throw new AppError("INTERNAL_ERROR", "Turn image upload failed");
    }
    if (!error) uploadedPaths.push(storagePath);
    images.push({
      id,
      name,
      mime_type: mimeType,
      size: bytes.byteLength,
      storage_path: storagePath,
      content_sha256: sha256,
    });
  }

  const requestInput = {
    sessionId,
    title,
    content: input.content,
    images,
    model: input.model ?? null,
    reasoning_effort: input.reasoning_effort ?? null,
    goal_mode: input.goal_mode ?? null,
  };
  try {
    const result = await callDomainRpc("create_session_turn_with_settings", {
      ...userContext(context),
      p_session_id: sessionId,
      p_title: title,
      p_content: input.content,
      p_priority: 50,
      p_images: images,
      p_model: input.model ?? null,
      p_reasoning_effort: input.reasoning_effort ?? null,
      p_goal_mode: input.goal_mode ?? null,
      ...commandMetadata("create_session_turn", requestInput, idempotencyKey),
    });
    if (!result.task || !result.message || !result.activity) {
      throw new AppError("INTERNAL_ERROR", "Session turn creation returned incomplete data");
    }
    return result;
  } catch (error) {
    if (uploadedPaths.length) {
      const ids = images.map((image) => image.id);
      const { data: committed } = await admin
        .from("artifacts")
        .select("id")
        .in("id", ids);
      const committedIds = new Set((committed ?? []).map((row) => row.id));
      const orphanedPaths = images
        .filter((image) => !committedIds.has(image.id) && uploadedPaths.includes(image.storage_path))
        .map((image) => image.storage_path);
      if (orphanedPaths.length) {
        await admin.storage.from("task-artifacts").remove(orphanedPaths).catch(() => undefined);
      }
    }
    throw error;
  }
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

import { z } from "zod";

import {
  capabilitiesSchema,
  nonEmptyText,
  optionalText,
  prioritySchema,
  uuidSchema,
} from "@/lib/validation/common";

export const workspaceQuerySchema = z.object({ workspace_id: uuidSchema.optional() }).strict();

export const sessionParamsSchema = z.object({ sessionId: uuidSchema }).strict();

const bigintCursorSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, "Expected a positive decimal cursor")
  .refine(
    (value) =>
      value.length < 19 || value <= "9223372036854775807",
    "Cursor exceeds bigint range",
  );

const opaqueActivityCursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected a base64url activity cursor");

export const sessionConversationQuerySchema = z
  .object({
    workspace_id: uuidSchema.optional(),
    before_activity_cursor: opaqueActivityCursorSchema.optional(),
    // Kept for one rolling-deployment window. New clients must use the
    // compound cursor because an identity-only boundary cannot order a late
    // import whose occurred_at predates its insertion id.
    before_activity_id: bigintCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict()
  .refine(
    (value) =>
      !(value.before_activity_cursor && value.before_activity_id),
    {
      message: "Use only one activity cursor",
      path: ["before_activity_cursor"],
    },
  );

export const createSessionTurnSchema = z
  .object({ content: nonEmptyText.max(100_000) })
  .strict();

export const createTaskSchema = z
  .object({
    workspace_id: uuidSchema.optional(),
    parent_task_id: uuidSchema.nullable().optional(),
    title: nonEmptyText.max(500),
    description: optionalText,
    acceptance_criteria: optionalText,
    priority: prioritySchema,
    position: z.number().int().nonnegative().nullable().optional(),
    // Web Console 不创建公共任务池；每个新任务都必须预留给一个存活会话。
    assigned_session_id: uuidSchema,
    required_capabilities: capabilitiesSchema,
  })
  .strict();

export const updateTaskSchema = z
  .object({
    title: nonEmptyText.max(500).optional(),
    description: optionalText,
    acceptance_criteria: optionalText,
    priority: z.number().int().min(-1000).max(1000).optional(),
    position: z.number().int().nonnegative().nullable().optional(),
    // Queued leaf work may be explicitly moved to another live session, but
    // cannot be turned back into an unassigned public task through the API.
    assigned_session_id: uuidSchema.optional(),
    required_capabilities: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const userTaskCommandSchema = z
  .object({ reason: optionalText })
  .strict();

export const replyToTaskSchema = z
  .object({
    content: nonEmptyText.max(100_000),
    reply_to_message_id: uuidSchema.nullable().optional(),
  })
  .strict();

export const createConnectionSchema = z
  .object({
    workspace_id: uuidSchema.optional(),
    name: nonEmptyText.max(200),
    platform: nonEmptyText.max(100),
  })
  .strict();

const userSubtaskSchema = z
  .object({
    client_ref: z.string().trim().min(1).max(100),
    title: nonEmptyText.max(500),
    description: optionalText,
    acceptance_criteria: optionalText,
    priority: prioritySchema,
    position: z.number().int().nonnegative().nullable().optional(),
    assigned_session_id: uuidSchema,
    required_capabilities: capabilitiesSchema,
    depends_on: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  })
  .strict();

const bulkUserSubtasksSchema = z
  .object({ subtasks: z.array(userSubtaskSchema).min(1).max(100) })
  .strict();

const singleUserSubtaskSchema = z
  .object({
    title: nonEmptyText.max(500),
    description: optionalText,
    acceptance_criteria: optionalText,
    priority: prioritySchema,
    position: z.number().int().nonnegative().nullable().optional(),
    assigned_session_id: uuidSchema,
    required_capabilities: capabilitiesSchema,
    depends_on_task_ids: z.array(uuidSchema).max(100).default([]),
  })
  .strict()
  .transform((value) => ({
    subtasks: [
      {
        client_ref: "new-task",
        title: value.title,
        description: value.description,
        acceptance_criteria: value.acceptance_criteria,
        priority: value.priority,
        position: value.position,
        assigned_session_id: value.assigned_session_id,
        required_capabilities: value.required_capabilities,
        depends_on: value.depends_on_task_ids,
      },
    ],
  }));

export const createUserSubtasksSchema = z.union([
  bulkUserSubtasksSchema,
  singleUserSubtaskSchema,
]);

export const taskListQuerySchema = z
  .object({
    workspace_id: uuidSchema.optional(),
    status: z.string().trim().optional(),
    root_task_id: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict();

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ReplyToTaskInput = z.infer<typeof replyToTaskSchema>;
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
export type CreateUserSubtasksInput = z.infer<typeof createUserSubtasksSchema>;
export type CreateSessionTurnInput = z.infer<typeof createSessionTurnSchema>;

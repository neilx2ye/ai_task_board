import { z } from "zod";

import {
  artifactReferenceSchema,
  bridgeDirectoryKeySchema,
  capabilitiesSchema,
  nonEmptyText,
  optionalText,
  prioritySchema,
  progressPercentSchema,
  uuidSchema,
} from "@/lib/validation/common";

export const registerSessionSchema = z
  .object({
    name: nonEmptyText.max(200),
    platform: nonEmptyText.max(100),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    external_conversation_ref: z.string().trim().min(1).max(500).nullable().optional(),
    capabilities: capabilitiesSchema,
  })
  .strict();

const syncedThreadSchema = z
  .object({
    external_conversation_ref: z.string().trim().min(1).max(500),
    name: nonEmptyText.max(200),
    platform: nonEmptyText.max(100).default("codex"),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    working_directory: z.string().trim().min(1).max(4096).nullable().optional(),
    directory_key: bridgeDirectoryKeySchema.nullable().optional(),
    capabilities: capabilitiesSchema,
    archived: z.boolean().default(false),
  })
  .strict();

const syncedBridgeDirectorySchema = z
  .object({
    directory_key: bridgeDirectoryKeySchema,
    name: nonEmptyText.max(200),
    working_directory: nonEmptyText.max(4096),
  })
  .strict();

export const syncSessionsSchema = z
  .object({
    bridge_version: nonEmptyText.max(100),
    directories: z
      .array(syncedBridgeDirectorySchema)
      .min(1)
      .max(100)
      .optional(),
    threads: z.array(syncedThreadSchema).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const directoryKeys = new Set<string>();
    const directoryPaths = new Set<string>();
    value.directories?.forEach((directory, index) => {
      if (directoryKeys.has(directory.directory_key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate directory_key: ${directory.directory_key}`,
          path: ["directories", index, "directory_key"],
        });
      }
      if (directoryPaths.has(directory.working_directory)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate working_directory: ${directory.working_directory}`,
          path: ["directories", index, "working_directory"],
        });
      }
      directoryKeys.add(directory.directory_key);
      directoryPaths.add(directory.working_directory);
    });

    const references = new Set<string>();
    value.threads.forEach((thread, index) => {
      if (references.has(thread.external_conversation_ref)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate external_conversation_ref: ${thread.external_conversation_ref}`,
          path: ["threads", index, "external_conversation_ref"],
        });
      }
      references.add(thread.external_conversation_ref);
      if (thread.directory_key && !directoryKeys.has(thread.directory_key)) {
        context.addIssue({
          code: "custom",
          message: `Unknown directory_key: ${thread.directory_key}`,
          path: ["threads", index, "directory_key"],
        });
      }
    });

    if (
      new TextEncoder().encode(
        JSON.stringify({
          directories: value.directories ?? null,
          threads: value.threads,
        }),
      ).byteLength >
      1120 * 1024
    ) {
      context.addIssue({
        code: "too_big",
        maximum: 1120 * 1024,
        origin: "value",
        inclusive: true,
        message: "Bridge inventory must not exceed 1120 KiB",
        path: [],
      });
    }
  });

export const claimOptionsSchema = z
  .object({
    lease_seconds: z.number().int().min(60).max(3_600).optional(),
  })
  .strict();

export const sessionHeartbeatSchema = z.object({}).strict();

export const claimThreadCommandSchema = z
  .object({
    runtime_instance_id: uuidSchema,
    lease_seconds: z.number().int().min(15).max(300).default(60),
  })
  .strict();

export const completeThreadCommandSchema = z
  .object({
    runtime_instance_id: uuidSchema,
    succeeded: z.boolean(),
    external_thread_id: z.string().trim().min(1).max(500).nullable().optional(),
    error: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.succeeded && value.error) {
      context.addIssue({
        code: "custom",
        message: "A successful command cannot include an error",
        path: ["error"],
      });
    }
    if (!value.succeeded && !value.error) {
      context.addIssue({
        code: "custom",
        message: "A failed command must include an error",
        path: ["error"],
      });
    }
  });

export type ClaimThreadCommandInput = z.infer<
  typeof claimThreadCommandSchema
>;
export type CompleteThreadCommandInput = z.infer<
  typeof completeThreadCommandSchema
>;

export const reportCurrentTaskSchema = z
  .object({
    title: nonEmptyText.max(500),
    description: optionalText,
    acceptance_criteria: optionalText,
    external_task_ref: nonEmptyText.max(500),
    external_source: z.string().trim().min(1).max(100).optional(),
    external_conversation_ref: z.string().trim().min(1).max(500).nullable().optional(),
    priority: prioritySchema,
    progress_note: optionalText,
    progress_percent_estimate: progressPercentSchema,
    required_capabilities: capabilitiesSchema,
  })
  .strict();

export const claimTaskSchema = claimOptionsSchema
  .extend({ task_id: uuidSchema })
  .strict();

export const heartbeatClaimSchema = claimOptionsSchema
  .extend({
    task_id: uuidSchema,
    claim_token: nonEmptyText.max(500),
  })
  .strict();

const subtaskSchema = z
  .object({
    client_ref: z.string().trim().min(1).max(100),
    title: nonEmptyText.max(500),
    description: optionalText,
    acceptance_criteria: optionalText,
    priority: prioritySchema,
    position: z.number().int().nonnegative().nullable().optional(),
    required_capabilities: capabilitiesSchema,
    depends_on: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  })
  .strict();

export const createSubtasksSchema = z
  .object({
    task_id: uuidSchema,
    claim_token: nonEmptyText.max(500),
    subtasks: z.array(subtaskSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const refs = new Set<string>();
    value.subtasks.forEach((subtask, index) => {
      if (refs.has(subtask.client_ref)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate client_ref: ${subtask.client_ref}`,
          path: ["subtasks", index, "client_ref"],
        });
      }
      refs.add(subtask.client_ref);
    });
    value.subtasks.forEach((subtask, index) => {
      subtask.depends_on.forEach((dependency, dependencyIndex) => {
        if (!refs.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `Unknown dependency client_ref: ${dependency}`,
            path: ["subtasks", index, "depends_on", dependencyIndex],
          });
        }
        if (dependency === subtask.client_ref) {
          context.addIssue({
            code: "custom",
            message: "A subtask cannot depend on itself",
            path: ["subtasks", index, "depends_on", dependencyIndex],
          });
        }
      });
    });
  });

const claimedTaskCommand = z
  .object({
    task_id: uuidSchema,
    claim_token: nonEmptyText.max(500),
  })
  .strict();

export const reportProgressSchema = claimedTaskCommand
  .extend({
    progress_note: nonEmptyText.max(10_000),
    progress_percent_estimate: progressPercentSchema,
  })
  .strict();

export const requestUserInputSchema = claimedTaskCommand
  .extend({ question: nonEmptyText.max(10_000) })
  .strict();

const taskUserInputOptionSchema = z
  .object({
    label: nonEmptyText.max(500),
    description: z.string().max(2_000),
  })
  .strict();

const taskUserInputQuestionSchema = z
  .object({
    id: nonEmptyText.max(200),
    header: nonEmptyText.max(100),
    question: nonEmptyText.max(10_000),
    options: z.array(taskUserInputOptionSchema).min(1).max(20).nullable().default(null),
    isOther: z.boolean().default(false),
    isSecret: z.boolean().default(false),
  })
  .strict()
  .superRefine((question, context) => {
    if (!question.options) return;
    const labels = new Set<string>();
    question.options.forEach((option, index) => {
      if (labels.has(option.label)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate option label: ${option.label}`,
          path: ["options", index, "label"],
        });
      }
      labels.add(option.label);
    });
  });

export const registerTaskUserInputRequestSchema = claimedTaskCommand
  .extend({
    request_id: uuidSchema,
    external_request_id: nonEmptyText.max(500),
    turn_id: nonEmptyText.max(500),
    item_id: nonEmptyText.max(500),
    is_blocking: z.literal(true),
    questions: z.array(taskUserInputQuestionSchema).min(1).max(3),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.questions.forEach((question, index) => {
      if (ids.has(question.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate question id: ${question.id}`,
          path: ["questions", index, "id"],
        });
      }
      ids.add(question.id);
    });
    if (
      new TextEncoder().encode(JSON.stringify(value.questions)).byteLength >
      100_000
    ) {
      context.addIssue({
        code: "too_big",
        maximum: 100_000,
        origin: "value",
        inclusive: true,
        message: "Structured questions must not exceed 100 KiB",
        path: ["questions"],
      });
    }
  });

export const pollTaskUserInputRequestSchema = claimedTaskCommand
  .extend({ request_id: uuidSchema })
  .strict();

export const postTaskMessageSchema = z
  .object({
    task_id: uuidSchema,
    claim_token: z.string().trim().min(1).max(500),
    content: nonEmptyText.max(100_000),
    reply_to_message_id: uuidSchema.nullable().optional(),
  })
  .strict();

export const sessionActivityKindSchema = z.enum([
  "assistant_message",
  "reasoning",
  "command",
  "file_change",
  "mcp_tool",
  "web_search",
  "plan",
  "error",
  "usage",
  "status",
]);

function isCodexStreamDelta(data: Record<string, unknown>) {
  return (
    data.protocol === "codex-app-server/v1" && data.phase === "delta"
  );
}

export const reportSessionActivitySchema = claimedTaskCommand
  .extend({
    kind: sessionActivityKindSchema,
    content: z.string().nullable().optional(),
    data: z.record(z.string(), z.unknown()).default({}),
    external_ref: nonEmptyText.max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const content =
      typeof value.content === "string"
        ? isCodexStreamDelta(value.data)
          ? value.content
          : value.content.trim()
        : null;
    if (
      content !== null &&
      (content.length < 1 || content.length > 100_000)
    ) {
      context.addIssue({
        code: "custom",
        message: "Activity content must contain between 1 and 100000 characters",
        path: ["content"],
      });
    }
    if (
      ["assistant_message", "reasoning"].includes(value.kind) &&
      !content
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.kind} requires content`,
        path: ["content"],
      });
    }
    const encoded = JSON.stringify(value.data);
    if (new TextEncoder().encode(encoded).byteLength > 256 * 1024) {
      context.addIssue({
        code: "too_big",
        maximum: 256 * 1024,
        origin: "value",
        inclusive: true,
        message: "Activity data must not exceed 256 KiB",
        path: ["data"],
      });
    }
  })
  .transform((value) => {
    if (
      typeof value.content !== "string" ||
      isCodexStreamDelta(value.data)
    ) {
      return value;
    }
    return { ...value, content: value.content.trim() };
  });

export const HISTORY_IMPORT_MAX_ITEMS = 100;
export const HISTORY_IMPORT_MAX_CONTENT_LENGTH = 50_000;
export const HISTORY_IMPORT_MAX_DATA_BYTES = 4 * 1024;
export const HISTORY_IMPORT_MAX_ITEMS_BYTES = 512 * 1024;

const historyItemDataSchema = z
  .object({
    protocol: z.literal("codex-app-server/v1"),
    thread_id: z.string().trim().min(1).max(500),
    turn_id: z.string().trim().min(1).max(500),
    item_id: z.string().trim().min(1).max(500),
  })
  .strict();

const historyItemSchema = z
  .object({
    external_ref: nonEmptyText.max(500),
    kind: z.enum(["user_message", "assistant_message", "reasoning"]),
    // Preserve provider text byte-for-byte (notably Markdown fences and final
    // newlines); trim is used only to reject an all-whitespace payload.
    content: z
      .string()
      .max(HISTORY_IMPORT_MAX_CONTENT_LENGTH)
      .refine((value) => value.trim().length > 0, {
        message: "History content must not be blank",
      }),
    occurred_at: z.iso.datetime({ offset: true }),
    source_order: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    data: historyItemDataSchema,
  })
  .strict();

const historySyncReportSchema = z
  .object({
    status: z.enum(["syncing", "partial", "complete", "failed"]),
    turn_limit: z.number().int().min(1).max(500),
    scanned_turns: z.number().int().min(0).max(500),
    total_turns: z.number().int().min(0).max(1_000_000).nullable(),
    next_cursor: z.string().trim().min(1).max(2_000).nullable(),
    error: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scanned_turns > value.turn_limit) {
      context.addIssue({
        code: "custom",
        message: "scanned_turns must not exceed turn_limit",
        path: ["scanned_turns"],
      });
    }
    if (
      value.total_turns !== null &&
      value.total_turns < value.scanned_turns
    ) {
      context.addIssue({
        code: "custom",
        message: "total_turns must not be lower than scanned_turns",
        path: ["total_turns"],
      });
    }
    if (value.status === "complete" && value.next_cursor !== null) {
      context.addIssue({
        code: "custom",
        message: "A complete history sync cannot have a next_cursor",
        path: ["next_cursor"],
      });
    }
    if (value.status === "failed" && value.error === null) {
      context.addIssue({
        code: "custom",
        message: "A failed history sync requires an error",
        path: ["error"],
      });
    }
    if (value.status !== "failed" && value.error !== null) {
      context.addIssue({
        code: "custom",
        message: "Only a failed history sync may include an error",
        path: ["error"],
      });
    }
  });

/** A runtime-fenced, append-only batch of normalized Codex history. */
export const importSessionHistorySchema = z
  .object({
    runtime_instance_id: uuidSchema,
    report_sequence: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER),
    // Empty batches are intentional: a thread with no importable items still
    // has to publish its terminal sync status.
    items: z.array(historyItemSchema).max(HISTORY_IMPORT_MAX_ITEMS),
    sync: historySyncReportSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const externalReferences = new Set<string>();
    value.items.forEach((item, index) => {
      if (externalReferences.has(item.external_ref)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate history external_ref: ${item.external_ref}`,
          path: ["items", index, "external_ref"],
        });
      }
      externalReferences.add(item.external_ref);

      const dataBytes = new TextEncoder().encode(
        JSON.stringify(item.data),
      ).byteLength;
      if (dataBytes > HISTORY_IMPORT_MAX_DATA_BYTES) {
        context.addIssue({
          code: "too_big",
          maximum: HISTORY_IMPORT_MAX_DATA_BYTES,
          origin: "value",
          inclusive: true,
          message: "History item data must not exceed 4 KiB",
          path: ["items", index, "data"],
        });
      }
    });

    const itemsBytes = new TextEncoder().encode(
      JSON.stringify(value.items),
    ).byteLength;
    if (itemsBytes > HISTORY_IMPORT_MAX_ITEMS_BYTES) {
      context.addIssue({
        code: "too_big",
        maximum: HISTORY_IMPORT_MAX_ITEMS_BYTES,
        origin: "value",
        inclusive: true,
        message: "History items must not exceed 512 KiB",
        path: ["items"],
      });
    }
  });

export const completeTaskSchema = claimedTaskCommand
  .extend({
    result_summary: optionalText,
    result_json: z.unknown().nullable().optional(),
    message: optionalText,
    artifacts: z.array(artifactReferenceSchema).max(100).default([]),
  })
  .strict();

export const completeAndClaimNextSchema = completeTaskSchema
  .extend({ lease_seconds: z.number().int().min(60).max(3_600).optional() })
  .strict();

export const failTaskSchema = claimedTaskCommand
  .extend({
    reason: nonEmptyText.max(10_000),
    result_json: z.unknown().nullable().optional(),
  })
  .strict();

export const releaseTaskSchema = claimedTaskCommand
  .extend({ reason: optionalText })
  .strict();

export const getTaskParamsSchema = z.object({ taskId: uuidSchema }).strict();

export const taskUpdatesQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export type RegisterSessionInput = z.infer<typeof registerSessionSchema>;
export type SyncSessionsInput = z.infer<typeof syncSessionsSchema>;
export type ReportCurrentTaskInput = z.infer<typeof reportCurrentTaskSchema>;
export type ClaimOptionsInput = z.infer<typeof claimOptionsSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskSchema>;
export type HeartbeatClaimInput = z.infer<typeof heartbeatClaimSchema>;
export type CreateSubtasksInput = z.infer<typeof createSubtasksSchema>;
export type ReportProgressInput = z.infer<typeof reportProgressSchema>;
export type RequestUserInputInput = z.infer<typeof requestUserInputSchema>;
export type RegisterTaskUserInputRequestInput = z.infer<
  typeof registerTaskUserInputRequestSchema
>;
export type PollTaskUserInputRequestInput = z.infer<
  typeof pollTaskUserInputRequestSchema
>;
export type PostTaskMessageInput = z.infer<typeof postTaskMessageSchema>;
export type ReportSessionActivityInput = z.infer<typeof reportSessionActivitySchema>;
export type ImportSessionHistoryInput = z.infer<
  typeof importSessionHistorySchema
>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
export type FailTaskInput = z.infer<typeof failTaskSchema>;
export type ReleaseTaskInput = z.infer<typeof releaseTaskSchema>;

import { z } from "zod";

import {
  artifactReferenceSchema,
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

export const claimOptionsSchema = z
  .object({
    lease_seconds: z.number().int().min(60).max(3_600).optional(),
  })
  .strict();

export const sessionHeartbeatSchema = z.object({}).strict();

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

export const postTaskMessageSchema = z
  .object({
    task_id: uuidSchema,
    claim_token: z.string().trim().min(1).max(500),
    content: nonEmptyText.max(100_000),
    reply_to_message_id: uuidSchema.nullable().optional(),
  })
  .strict();

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
export type ReportCurrentTaskInput = z.infer<typeof reportCurrentTaskSchema>;
export type ClaimOptionsInput = z.infer<typeof claimOptionsSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskSchema>;
export type HeartbeatClaimInput = z.infer<typeof heartbeatClaimSchema>;
export type CreateSubtasksInput = z.infer<typeof createSubtasksSchema>;
export type ReportProgressInput = z.infer<typeof reportProgressSchema>;
export type RequestUserInputInput = z.infer<typeof requestUserInputSchema>;
export type PostTaskMessageInput = z.infer<typeof postTaskMessageSchema>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
export type FailTaskInput = z.infer<typeof failTaskSchema>;
export type ReleaseTaskInput = z.infer<typeof releaseTaskSchema>;

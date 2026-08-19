import { z } from "zod";

import {
  bridgeDirectoryKeySchema,
  nonEmptyText,
} from "@/lib/validation/common";

export const BRIDGE_CONFIG_BODY_LIMIT_BYTES = 1152 * 1024;
export const BRIDGE_CONFIG_MAX_VERSION = 2_147_483_647;
export const BRIDGE_CONFIG_MAX_REPORT_SEQUENCE = Number.MAX_SAFE_INTEGER;

export const bridgeWorkingDirectorySchema = z
  .object({
    directory_key: bridgeDirectoryKeySchema,
    name: nonEmptyText.max(200),
    working_directory: nonEmptyText.max(4096),
    create_if_missing: z.boolean().optional(),
  })
  .strict();

export const bridgeWorkingDirectoriesSchema = z
  .array(bridgeWorkingDirectorySchema)
  .min(1)
  .max(100)
  .superRefine((directories, context) => {
    const keys = new Set<string>();
    const paths = new Set<string>();
    directories.forEach((directory, index) => {
      if (keys.has(directory.directory_key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate directory_key: ${directory.directory_key}`,
          path: [index, "directory_key"],
        });
      }
      if (paths.has(directory.working_directory)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate working_directory: ${directory.working_directory}`,
          path: [index, "working_directory"],
        });
      }
      keys.add(directory.directory_key);
      paths.add(directory.working_directory);
    });
  })
  .nullable();

export const bridgeDesiredConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    include_thread_titles: z.boolean(),
    max_threads: z.number().int().min(1).max(500),
    max_concurrent_turns: z.number().int().min(1).max(32),
    sync_history: z.boolean(),
    history_turn_limit: z.number().int().min(1).max(500),
    working_directories: bridgeWorkingDirectoriesSchema,
  })
  .strict();

export const updateBridgeConfigurationSchema =
  bridgeDesiredConfigurationSchema
    .extend({
      expected_version: z
        .number()
        .int()
        .min(1)
        .max(BRIDGE_CONFIG_MAX_VERSION),
    })
    .strict();

/** Web 触发的 Bridge 自更新目标版本；null 表示取消待升级。 */
export const updateBridgeVersionSchema = z
  .object({
    target_version: nonEmptyText.max(50).nullable(),
  })
  .strict();

export const bridgeConfigurationConstraintsSchema = z
  .object({
    remote_configuration_enabled: z.boolean(),
    allow_thread_titles: z.boolean(),
    max_threads: z.number().int().min(1).max(500),
    max_concurrent_turns: z.number().int().min(1).max(32),
    thread_scope: z.enum(["cwd", "all"]),
    working_directory: z.string().max(4096),
    fixed_thread: z.boolean(),
    permission_mode: z.enum(["safe", "inherit", "danger-full-access"]),
    approval_mode: z.enum(["decline", "accept", "accept-session"]),
    allow_history_sync: z.boolean(),
    max_history_turns: z.number().int().min(1).max(500),
    allow_working_directory_configuration: z.boolean(),
  })
  .strict();

// Older Bridge reports do not contain history or Web-managed-directory fields.
// Defaults keep those generations online during a rolling deployment while
// failing closed for both capabilities.
const bridgeEffectiveReportSchema = bridgeDesiredConfigurationSchema.extend({
  sync_history: z.boolean().default(false),
  history_turn_limit: z.number().int().min(1).max(500).default(50),
  working_directories: bridgeWorkingDirectoriesSchema.default(null),
});

const bridgeConstraintsReportSchema =
  bridgeConfigurationConstraintsSchema.extend({
    allow_history_sync: z.boolean().default(false),
    max_history_turns: z.number().int().min(1).max(500).default(50),
    allow_working_directory_configuration: z.boolean().default(false),
  });

export const exchangeBridgeConfigurationSchema = z
  .object({
    runtime_instance_id: z.string().uuid(),
    /** Canonical Bridge runtime kind (codex/kimi/antigravity/claude). */
    platform: nonEmptyText.max(100).optional(),
    report_sequence: z
      .number()
      .int()
      .min(1)
      .max(BRIDGE_CONFIG_MAX_REPORT_SEQUENCE),
    lease_seconds: z.number().int().min(15).max(1800),
    release_runtime: z.boolean().default(false),
    applied_version: z
      .number()
      .int()
      .min(1)
      .max(BRIDGE_CONFIG_MAX_VERSION)
      .nullable(),
    effective: bridgeEffectiveReportSchema.nullable(),
    constraints: bridgeConstraintsReportSchema,
    error: z.string().max(2000).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.effective) return;
    if (value.effective.max_threads > value.constraints.max_threads) {
      context.addIssue({
        code: "custom",
        message: "Effective max_threads exceeds the reported constraint",
        path: ["effective", "max_threads"],
      });
    }
    if (
      value.effective.max_concurrent_turns >
      value.constraints.max_concurrent_turns
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Effective max_concurrent_turns exceeds the reported constraint",
        path: ["effective", "max_concurrent_turns"],
      });
    }
    if (
      value.effective.include_thread_titles &&
      !value.constraints.allow_thread_titles
    ) {
      context.addIssue({
        code: "custom",
        message: "Effective thread titles require local title permission",
        path: ["effective", "include_thread_titles"],
      });
    }
    if (
      value.effective.sync_history &&
      !value.constraints.allow_history_sync
    ) {
      context.addIssue({
        code: "custom",
        message: "Effective history sync requires local history permission",
        path: ["effective", "sync_history"],
      });
    }
    if (
      value.effective.history_turn_limit >
      value.constraints.max_history_turns
    ) {
      context.addIssue({
        code: "custom",
        message: "Effective history_turn_limit exceeds the local constraint",
        path: ["effective", "history_turn_limit"],
      });
    }
  });

export type UpdateBridgeConfigurationInput = z.infer<
  typeof updateBridgeConfigurationSchema
>;
export type UpdateBridgeVersionInput = z.infer<
  typeof updateBridgeVersionSchema
>;
export type ExchangeBridgeConfigurationInput = z.infer<
  typeof exchangeBridgeConfigurationSchema
>;

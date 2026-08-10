import { z } from "zod";

export const BRIDGE_CONFIG_BODY_LIMIT_BYTES = 32 * 1024;
export const BRIDGE_CONFIG_MAX_VERSION = 2_147_483_647;
export const BRIDGE_CONFIG_MAX_REPORT_SEQUENCE = Number.MAX_SAFE_INTEGER;

export const bridgeDesiredConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    include_thread_titles: z.boolean(),
    max_threads: z.number().int().min(1).max(500),
    max_concurrent_turns: z.number().int().min(1).max(32),
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

export const bridgeConfigurationConstraintsSchema = z
  .object({
    remote_configuration_enabled: z.boolean(),
    allow_thread_titles: z.boolean(),
    max_threads: z.number().int().min(1).max(500),
    max_concurrent_turns: z.number().int().min(1).max(32),
    thread_scope: z.enum(["cwd", "all"]),
    working_directory: z.string().max(4096),
    fixed_thread: z.boolean(),
    permission_mode: z.enum(["safe", "inherit"]),
    approval_mode: z.enum(["decline", "accept", "accept-session"]),
  })
  .strict();

export const exchangeBridgeConfigurationSchema = z
  .object({
    runtime_instance_id: z.string().uuid(),
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
    effective: bridgeDesiredConfigurationSchema.nullable(),
    constraints: bridgeConfigurationConstraintsSchema,
    error: z.string().max(2000).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.effective) return;
    if (value.effective.max_threads > value.constraints.max_threads) {
      context.addIssue({
        code: "custom",
        message: "Effective max_threads exceeds the local constraint",
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
          "Effective max_concurrent_turns exceeds the local constraint",
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
  });

export type UpdateBridgeConfigurationInput = z.infer<
  typeof updateBridgeConfigurationSchema
>;
export type ExchangeBridgeConfigurationInput = z.infer<
  typeof exchangeBridgeConfigurationSchema
>;

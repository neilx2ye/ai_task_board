import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const nonEmptyText = z.string().trim().min(1);
export const optionalText = z.string().trim().min(1).nullable().optional();
export const capabilitySchema = z.string().trim().min(1).max(100);
export const capabilitiesSchema = z.array(capabilitySchema).max(100).default([]);
export const progressPercentSchema = z.number().int().min(0).max(100).nullable().optional();
export const prioritySchema = z.number().int().min(-1000).max(1000).default(0);
export const idempotencyKeySchema = z.string().trim().min(1).max(200);

const storageUuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const artifactFilenamePattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;

function isPrivateArtifactPath(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.length === 3 &&
    storageUuidPattern.test(parts[0] ?? "") &&
    storageUuidPattern.test(parts[1] ?? "") &&
    artifactFilenamePattern.test(parts[2] ?? "") &&
    !(parts[2] ?? "").includes("..")
  );
}

export const artifactReferenceSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    mime_type: z.string().trim().min(1).max(255),
    size: z.number().int().nonnegative().max(5_000_000_000),
    storage_path: z
      .string()
      .trim()
      .min(1)
      .refine(isPrivateArtifactPath, {
        message:
          "storage_path must be <workspace_uuid>/<task_uuid>/<artifact_uuid>-<safe_filename>",
      })
      .nullable()
      .optional(),
    external_url: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
        message: "external_url must use http or https",
      })
      .nullable()
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.storage_path) !== Boolean(value.external_url), {
    message: "An artifact must include exactly one of storage_path or external_url",
  });

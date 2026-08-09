import { z } from "zod";

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export const uploadFileSchema = z
  .custom<File>(
    (value) => typeof File !== "undefined" && value instanceof File,
    "multipart field 'file' must be a file",
  )
  .refine((file) => file.size <= MAX_ARTIFACT_BYTES, "File must not exceed 50 MB")
  .refine((file) => file.name.trim().length > 0, "File name is required");

/** A conservative object-name segment; the original display name stays in metadata. */
export function safeFilename(filename: string): string {
  const basename = filename.normalize("NFKC").split(/[\\/]/).at(-1) ?? "artifact";
  const safe = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/\.{2,}/g, ".")
    .replace(/_+/g, "_")
    .slice(0, 180);
  return safe || "artifact";
}

export function safeMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized.slice(0, 255)
    : "application/octet-stream";
}

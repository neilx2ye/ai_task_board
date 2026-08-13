import { z } from "zod";

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const MAX_TURN_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TURN_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_TURN_IMAGES = 4;
export const TURN_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

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

export function validateTurnImages(files: File[]): File[] {
  if (files.length > MAX_TURN_IMAGES) {
    throw new Error(`A turn may contain at most ${MAX_TURN_IMAGES} images`);
  }
  let total = 0;
  for (const file of files) {
    if (!TURN_IMAGE_MIME_TYPES.includes(file.type as (typeof TURN_IMAGE_MIME_TYPES)[number])) {
      throw new Error(`Unsupported image type: ${file.type || "unknown"}`);
    }
    if (file.size < 1 || file.size > MAX_TURN_IMAGE_BYTES) {
      throw new Error("Each image must be between 1 byte and 10 MiB");
    }
    total += file.size;
  }
  if (total > MAX_TURN_IMAGE_TOTAL_BYTES) {
    throw new Error("Turn images must not exceed 20 MiB in total");
  }
  return files;
}

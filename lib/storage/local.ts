import "server-only";

import { createHmac, timingSafeEqual as constantTimeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { getAITokenPepper, getAppUrl, getLocalStorageDir } from "@/lib/env";

export type StorageError = {
  message: string;
  status?: number;
  statusCode?: string;
};

export type UploadOptions = {
  contentType?: string;
  upsert?: boolean;
};

const BUCKETS = ["task-artifacts"] as const;

function bucketRoot(bucket: string): string {
  if (!(BUCKETS as readonly string[]).includes(bucket)) {
    throw new Error(`Unknown storage bucket: ${bucket}`);
  }
  const root = path.join(getLocalStorageDir(), bucket);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Resolve an object path inside the bucket root, rejecting traversal. */
function objectPath(bucket: string, name: string): string {
  const root = bucketRoot(bucket);
  const normalized = name.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "" || segment === "..")
  ) {
    throw new Error("Invalid storage object path");
  }
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Invalid storage object path");
  }
  return resolved;
}

export async function uploadObject(
  bucket: string,
  name: string,
  bytes: Uint8Array,
  options: UploadOptions = {},
): Promise<{ data: { path: string } | null; error: StorageError | null }> {
  const target = objectPath(bucket, name);
  if (existsSync(target) && !options.upsert) {
    return {
      data: null,
      error: {
        message: "The resource already exists",
        status: 409,
        statusCode: "409",
      },
    };
  }
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Upload failed";
    return { data: null, error: { message, statusCode: "500" } };
  }
  return { data: { path: name }, error: null };
}

export async function removeObjects(
  bucket: string,
  names: string[],
): Promise<{ data: null; error: StorageError | null }> {
  for (const name of names) {
    try {
      const target = objectPath(bucket, name);
      if (existsSync(target)) unlinkSync(target);
    } catch {
      // Removal is best-effort, mirroring hosted Storage bulk deletes.
    }
  }
  return { data: null, error: null };
}

export async function createSignedUrl(
  bucket: string,
  name: string,
  expiresInSeconds: number,
): Promise<
  { data: { signedUrl: string } | null; error: StorageError | null }
> {
  // Validate the path even for a URL that may be consumed later.
  objectPath(bucket, name);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = `${bucket}\0${name}\0${expiresAt}`;
  const signature = createHmac("sha256", getAITokenPepper())
    .update(payload)
    .digest("base64url");
  const query = new URLSearchParams({
    bucket,
    path: name,
    expires: String(expiresAt),
    sig: signature,
  });
  return {
    data: { signedUrl: `${getAppUrl()}/api/storage/object?${query.toString()}` },
    error: null,
  };
}

export function verifySignedObjectUrl(params: {
  bucket: string;
  path: string;
  expires: string;
  sig: string;
}): { valid: boolean; reason?: "signature" | "expired" } {
  const expiresAt = Number(params.expires);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: "expired" };
  }
  const payload = `${params.bucket}\0${params.path}\0${expiresAt}`;
  const expected = createHmac("sha256", getAITokenPepper())
    .update(payload)
    .digest("base64url");
  if (
    params.sig.length !== expected.length ||
    !timingSafeEqual(params.sig, expected)
  ) {
    return { valid: false, reason: "signature" };
  }
  return { valid: true };
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    constantTimeEqual(leftBytes, rightBytes)
  );
}

export function readObject(bucket: string, name: string): Buffer | null {
  const target = objectPath(bucket, name);
  return existsSync(target) ? readFileSync(target) : null;
}

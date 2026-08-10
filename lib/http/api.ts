import { NextResponse } from "next/server";
import type { ZodType } from "zod";

import { AppError, normalizeError } from "@/lib/domain/errors";
import { idempotencyKeySchema } from "@/lib/validation/common";

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

async function readRequestText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AppError("INTERNAL_ERROR", "Invalid request body limit");
  }

  const contentLength = request.headers.get("content-length")?.trim();
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    BigInt(contentLength) > BigInt(maxBytes)
  ) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `Request body must not exceed ${maxBytes} bytes`,
    );
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(maxBytes, 8 * 1024));
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextLength = byteLength + value.byteLength;
      if (nextLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(
          "PAYLOAD_TOO_LARGE",
          `Request body must not exceed ${maxBytes} bytes`,
        );
      }
      if (nextLength > bytes.byteLength) {
        let capacity = Math.max(bytes.byteLength * 2, nextLength);
        capacity = Math.min(capacity, maxBytes);
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, byteLength));
        bytes = grown;
      }
      bytes.set(value, byteLength);
      byteLength = nextLength;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_REQUEST", "Could not read request body");
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(bytes.subarray(0, byteLength));
}

export async function parseJson<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readRequestText(request, maxBytes)) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_REQUEST", "Request body must be valid JSON");
  }
  return schema.parse(value);
}

export async function parseJsonOrEmpty<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<T> {
  const body = await readRequestText(request, maxBytes);
  if (!body.trim()) return schema.parse({});
  try {
    return schema.parse(JSON.parse(body) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AppError("INVALID_REQUEST", "Request body must be valid JSON");
    }
    throw error;
  }
}

export function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    throw new AppError(
      "INVALID_REQUEST",
      "Idempotency-Key is required and must not exceed 200 characters",
    );
  }
  return idempotencyKeySchema.parse(value);
}

export function apiSuccess(data: unknown, status = 200): NextResponse {
  return NextResponse.json(
    { data },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function apiError(error: unknown): NextResponse {
  const normalized = normalizeError(error);
  return NextResponse.json(
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
      },
    },
    { status: normalized.status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function withApiHandler(
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (error) {
    return apiError(error);
  }
}

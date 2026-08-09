import { NextResponse } from "next/server";
import type { ZodType } from "zod";

import { AppError, normalizeError } from "@/lib/domain/errors";
import { idempotencyKeySchema } from "@/lib/validation/common";

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new AppError("INVALID_REQUEST", "Request body must be valid JSON");
  }
  return schema.parse(value);
}

export async function parseJsonOrEmpty<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const body = await request.text();
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

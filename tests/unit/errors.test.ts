import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AppError,
  BUSINESS_ERROR_CODES,
  mapDatabaseError,
  normalizeError,
} from "@/lib/domain/errors";

describe("stable API error mapping", () => {
  it.each([
    ["TASK_NOT_FOUND", 404],
    ["TASK_NOT_READY", 409],
    ["TASK_ALREADY_CLAIMED", 409],
    ["LEASE_EXPIRED", 409],
    ["INVALID_CLAIM_TOKEN", 403],
    ["DEPENDENCY_CYCLE", 409],
    ["SESSION_NOT_AUTHORIZED", 403],
    ["CAPABILITY_MISMATCH", 409],
    ["INVALID_STATE_TRANSITION", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["VERSION_CONFLICT", 409],
    ["BRIDGE_INSTANCE_CONFLICT", 409],
    ["HISTORY_SYNC_NOT_ALLOWED", 403],
    ["THREAD_MANAGEMENT_NOT_SUPPORTED", 409],
    ["THREAD_NOT_IDLE", 409],
  ] as const)("maps database marker %s to HTTP %s", (code, status) => {
    const error = mapDatabaseError({ message: `rpc rejected: ${code}` });

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain("rpc rejected");
  });

  it("keeps the required business error code list stable", () => {
    expect(BUSINESS_ERROR_CODES).toEqual([
      "TASK_NOT_FOUND",
      "TASK_NOT_READY",
      "TASK_ALREADY_CLAIMED",
      "LEASE_EXPIRED",
      "INVALID_CLAIM_TOKEN",
      "DEPENDENCY_CYCLE",
      "SESSION_NOT_AUTHORIZED",
      "CAPABILITY_MISMATCH",
      "INVALID_STATE_TRANSITION",
      "IDEMPOTENCY_CONFLICT",
      "VERSION_CONFLICT",
      "BRIDGE_INSTANCE_CONFLICT",
      "HISTORY_SYNC_NOT_ALLOWED",
      "THREAD_MANAGEMENT_NOT_SUPPORTED",
      "THREAD_NOT_IDLE",
      "INVALID_FILE_COMMAND",
      "PATH_NOT_FOUND",
    ]);
  });

  it.each([
    ["23503", "INVALID_REQUEST"],
    ["23514", "INVALID_REQUEST"],
    ["22P02", "INVALID_REQUEST"],
    ["22007", "INVALID_REQUEST"],
    ["23505", "IDEMPOTENCY_CONFLICT"],
  ] as const)("maps PostgreSQL code %s without leaking internals", (databaseCode, apiCode) => {
    const error = mapDatabaseError({
      code: databaseCode,
      message: "sensitive SQL and table names",
    });

    expect(error.code).toBe(apiCode);
    expect(error.message).not.toContain("sensitive");
  });

  it.each([
    ["SESSION_ALREADY_HAS_ACTIVE_TASK", "INVALID_STATE_TRANSITION", 409],
    ["PARENT_TASK_NOT_FOUND", "TASK_NOT_FOUND", 404],
    ["DEPENDENCY_NOT_FOUND", "TASK_NOT_FOUND", 404],
    ["TASK_HAS_CHILDREN", "INVALID_STATE_TRANSITION", 409],
    ["INVALID_ARTIFACTS", "INVALID_REQUEST", 400],
  ] as const)("maps internal RPC marker %s to stable %s", (marker, code, status) => {
    const error = mapDatabaseError({ code: "P0001", message: marker });

    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain(marker);
  });

  it("maps PostgreSQL insufficient privilege to FORBIDDEN", () => {
    const error = mapDatabaseError({ code: "42501", message: "policy internals" });

    expect(error.code).toBe("FORBIDDEN");
    expect(error.status).toBe(403);
    expect(error.message).not.toContain("policy internals");
  });

  it("turns Zod failures into a safe INVALID_REQUEST with field details", () => {
    const result = z.object({ percent: z.number().int().min(0).max(100) }).safeParse({
      percent: 101,
    });
    if (result.success) throw new Error("Expected validation to fail");

    const normalized = normalizeError(result.error);

    expect(normalized.code).toBe("INVALID_REQUEST");
    expect(normalized.status).toBe(400);
    expect(normalized.details).toMatchObject({ fieldErrors: { percent: expect.any(Array) } });
  });

  it("does not expose unknown exception messages", () => {
    const normalized = normalizeError(new Error("SUPABASE_SECRET_KEY=do-not-leak"));

    expect(normalized.code).toBe("INTERNAL_ERROR");
    expect(normalized.status).toBe(500);
    expect(normalized.message).toBe("An unexpected server error occurred");
  });
});

import { ZodError } from "zod";

export const BUSINESS_ERROR_CODES = [
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
] as const;

export type BusinessErrorCode = (typeof BUSINESS_ERROR_CODES)[number];
export type ApiErrorCode =
  | BusinessErrorCode
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL_ERROR";

const statusByCode: Record<ApiErrorCode, number> = {
  AUTHENTICATION_REQUIRED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  METHOD_NOT_ALLOWED: 405,
  TASK_NOT_FOUND: 404,
  TASK_NOT_READY: 409,
  TASK_ALREADY_CLAIMED: 409,
  LEASE_EXPIRED: 409,
  INVALID_CLAIM_TOKEN: 403,
  DEPENDENCY_CYCLE: 409,
  SESSION_NOT_AUTHORIZED: 403,
  CAPABILITY_MISMATCH: 409,
  INVALID_STATE_TRANSITION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  BRIDGE_INSTANCE_CONFLICT: 409,
  HISTORY_SYNC_NOT_ALLOWED: 403,
  THREAD_MANAGEMENT_NOT_SUPPORTED: 409,
  THREAD_NOT_IDLE: 409,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.details = details;
  }
}

type DatabaseErrorLike = { message?: string; code?: string; details?: string };

export function mapDatabaseError(error: DatabaseErrorLike): AppError {
  const source = `${error.code ?? ""} ${error.message ?? ""} ${error.details ?? ""}`;
  const stableCode = BUSINESS_ERROR_CODES.find((code) => source.includes(code));
  if (stableCode) return new AppError(stableCode, messageForCode(stableCode));

  if (source.includes("SESSION_ALREADY_HAS_ACTIVE_TASK")) {
    return new AppError(
      "INVALID_STATE_TRANSITION",
      "The AI session already has an active task",
    );
  }
  if (source.includes("PARENT_TASK_NOT_FOUND") || source.includes("DEPENDENCY_NOT_FOUND")) {
    return new AppError("TASK_NOT_FOUND", "A referenced task was not found");
  }
  if (source.includes("TASK_HAS_CHILDREN") || source.includes("INVALID_TASK_ROOT")) {
    return new AppError("INVALID_STATE_TRANSITION", "The task hierarchy cannot be changed that way");
  }
  if (/\bINVALID_[A-Z_]+\b/.test(source)) {
    return new AppError("INVALID_REQUEST", "The request contains invalid data");
  }

  if (error.code === "23505") {
    return new AppError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used");
  }
  if (error.code === "23503") {
    return new AppError("INVALID_REQUEST", "A referenced resource does not exist");
  }
  if (
    error.code === "23514" ||
    error.code === "22P02" ||
    error.code === "22007"
  ) {
    return new AppError("INVALID_REQUEST", "The request violates a data constraint");
  }
  if (error.code === "42501") {
    return new AppError("FORBIDDEN", "The operation is not permitted");
  }

  return new AppError("INTERNAL_ERROR", "The operation could not be completed");
}

function messageForCode(code: BusinessErrorCode): string {
  const messages: Record<BusinessErrorCode, string> = {
    TASK_NOT_FOUND: "Task not found",
    TASK_NOT_READY: "Task is not ready to be claimed",
    TASK_ALREADY_CLAIMED: "Task is already claimed",
    LEASE_EXPIRED: "The task lease has expired",
    INVALID_CLAIM_TOKEN: "The claim token is invalid",
    DEPENDENCY_CYCLE: "The dependency graph contains a cycle",
    SESSION_NOT_AUTHORIZED: "The AI session is not authorized",
    CAPABILITY_MISMATCH: "The AI session does not meet the task capabilities",
    INVALID_STATE_TRANSITION: "The requested task state transition is invalid",
    IDEMPOTENCY_CONFLICT: "The idempotency key conflicts with an earlier request",
    VERSION_CONFLICT: "The configuration was changed by another request",
    BRIDGE_INSTANCE_CONFLICT: "Another Bridge runtime is active for this connection",
    HISTORY_SYNC_NOT_ALLOWED: "Codex history sync is not enabled for this Bridge",
    THREAD_MANAGEMENT_NOT_SUPPORTED:
      "This Bridge version does not support Web Thread management",
    THREAD_NOT_IDLE: "The Thread still has active or queued work",
  };
  return messages[code];
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError("INVALID_REQUEST", "Request validation failed", error.flatten());
  }
  return new AppError("INTERNAL_ERROR", "An unexpected server error occurred");
}

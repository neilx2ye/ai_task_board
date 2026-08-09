import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getAITokenPepper } from "@/lib/env";

export type TokenKind = "connection" | "claim";

export function generateConnectionToken(): string {
  return `atb_${randomBytes(32).toString("base64url")}`;
}

export function deriveConnectionToken(scope: string): string {
  const value = createHmac("sha256", getAITokenPepper())
    .update(`ai-task-board:connection-issuance:v1\0${scope}`, "utf8")
    .digest("base64url");
  return `atb_${value}`;
}

export function deriveStableUuid(scope: string): string {
  const bytes = createHmac("sha256", getAITokenPepper())
    .update(`ai-task-board:uuid:v1\0${scope}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function generateClaimToken(): string {
  return `claim_${randomBytes(32).toString("base64url")}`;
}

/**
 * Claim tokens attached to idempotent commands must be reproducible: on a retry
 * PostgreSQL returns the cached first response and still stores the first hash.
 * This keyed derivation keeps the raw token unpredictable while making retries
 * return the same usable credential.
 */
export function deriveClaimToken(scope: string): string {
  const value = createHmac("sha256", getAITokenPepper())
    .update(`ai-task-board:claim-issuance:v1\0${scope}`, "utf8")
    .digest("base64url");
  return `claim_${value}`;
}

export function hashToken(token: string, kind: TokenKind = "connection"): string {
  return createHmac("sha256", getAITokenPepper())
    .update(`ai-task-board:${kind}:v1\0${token}`, "utf8")
    .digest("hex");
}

export function verifyToken(
  candidate: string,
  expectedHash: string,
  kind: TokenKind = "connection",
): boolean {
  const actual = Buffer.from(hashToken(candidate, kind), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function hashRequest(operation: string, input: unknown): string {
  return createHmac("sha256", getAITokenPepper())
    .update("ai-task-board:idempotency-request:v1\0", "utf8")
    .update(`${operation}\0${JSON.stringify(canonicalize(input))}`, "utf8")
    .digest("hex");
}

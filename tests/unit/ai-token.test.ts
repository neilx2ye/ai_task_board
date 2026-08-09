import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  deriveClaimToken,
  deriveConnectionToken,
  deriveStableUuid,
  generateClaimToken,
  generateConnectionToken,
  hashRequest,
  hashToken,
  verifyToken,
} from "@/lib/auth/ai-token";

describe("AI and claim token helpers", () => {
  beforeEach(() => {
    vi.stubEnv("AI_TOKEN_PEPPER", "test-only-pepper-with-at-least-32-characters");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generates high-entropy, typed tokens", () => {
    const connectionA = generateConnectionToken();
    const connectionB = generateConnectionToken();
    const claim = generateClaimToken();

    expect(connectionA).toMatch(/^atb_[A-Za-z0-9_-]{43}$/);
    expect(connectionB).toMatch(/^atb_[A-Za-z0-9_-]{43}$/);
    expect(claim).toMatch(/^claim_[A-Za-z0-9_-]{43}$/);
    expect(connectionA).not.toBe(connectionB);
  });

  it("hashes deterministically while separating connection and claim domains", () => {
    const token = "same-raw-secret";

    expect(hashToken(token, "connection")).toBe(hashToken(token, "connection"));
    expect(hashToken(token, "connection")).not.toBe(hashToken(token, "claim"));
  });

  it("derives a stable but scope-separated credential for idempotent claim retries", () => {
    const scope = "workspace\0connection\0session\0claim_task\0request-key";

    expect(deriveClaimToken(scope)).toMatch(/^claim_[A-Za-z0-9_-]{43}$/);
    expect(deriveClaimToken(scope)).toBe(deriveClaimToken(scope));
    expect(deriveClaimToken(scope)).not.toBe(deriveClaimToken(`${scope}-different`));
  });

  it("replays idempotent connection secrets and IDs without weakening scope separation", () => {
    const scope = "workspace\0user\0create_connection\0request-key";

    expect(deriveConnectionToken(scope)).toMatch(/^atb_[A-Za-z0-9_-]{43}$/);
    expect(deriveConnectionToken(scope)).toBe(deriveConnectionToken(scope));
    expect(deriveConnectionToken(scope)).not.toBe(deriveConnectionToken(`${scope}-other`));
    expect(deriveStableUuid(scope)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deriveStableUuid(scope)).toBe(deriveStableUuid(scope));
  });

  it("verifies only the correct token and token kind", () => {
    const hash = hashToken("claim-secret", "claim");

    expect(verifyToken("claim-secret", hash, "claim")).toBe(true);
    expect(verifyToken("wrong-secret", hash, "claim")).toBe(false);
    expect(verifyToken("claim-secret", hash, "connection")).toBe(false);
    expect(verifyToken("claim-secret", "not-a-hex-hash", "claim")).toBe(false);
  });

  it("canonicalizes object key order for idempotency request hashes", () => {
    const first = {
      title: "Research",
      nested: { z: 1, a: [{ beta: true, alpha: false }] },
    };
    const sameRequest = {
      nested: { a: [{ alpha: false, beta: true }], z: 1 },
      title: "Research",
    };

    expect(hashRequest("report_progress", first)).toBe(
      hashRequest("report_progress", sameRequest),
    );
    expect(hashRequest("report_progress", first)).not.toBe(
      hashRequest("complete_task", first),
    );
  });

  it("keys idempotency request hashes with the environment pepper", () => {
    const input = { task_id: "task", claim_token: "high-entropy-claim" };
    const first = hashRequest("complete_task", input);

    vi.stubEnv("AI_TOKEN_PEPPER", "a-different-test-pepper-with-at-least-32-characters");

    expect(hashRequest("complete_task", input)).not.toBe(first);
  });
});

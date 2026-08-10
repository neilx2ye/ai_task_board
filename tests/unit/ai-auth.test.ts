import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { shouldRefreshConnectionUsage } from "@/lib/auth/ai-auth";

describe("AI connection usage refresh", () => {
  const now = Date.parse("2026-08-09T12:00:00.000Z");

  it("refreshes a connection that has never been used", () => {
    expect(shouldRefreshConnectionUsage(null, now)).toBe(true);
  });

  it("does not rewrite the connection row during the five-minute window", () => {
    expect(
      shouldRefreshConnectionUsage("2026-08-09T11:56:00.000Z", now),
    ).toBe(false);
  });

  it("refreshes stale or invalid timestamps", () => {
    expect(
      shouldRefreshConnectionUsage("2026-08-09T11:55:00.000Z", now),
    ).toBe(true);
    expect(shouldRefreshConnectionUsage("not-a-date", now)).toBe(true);
  });
});

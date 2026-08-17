import { describe, expect, it } from "vitest";

import {
  normalizeCodexQuota,
  quotaError,
  unavailableQuota,
} from "../../packages/codex-bridge/src/account-quota";

describe("normalizeCodexQuota", () => {
  it("maps the five-hour and seven-day windows to percentages", () => {
    const result = normalizeCodexQuota(
      {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          planType: "pro",
          primary: {
            usedPercent: 37.5,
            resetsAt: 1_784_208_000,
            windowDurationMins: 300,
          },
          secondary: {
            usedPercent: 12,
            resetsAt: 1_784_640_000,
            windowDurationMins: 10_080,
          },
          credits: {
            balance: "1234",
            hasCredits: true,
            unlimited: false,
          },
        },
        rateLimitResetCredits: { availableCount: 2 },
      },
      new Date("2026-08-17T00:00:00.000Z"),
    );

    expect(result.status).toBe("ok");
    expect(result.plan).toBe("pro");
    expect(result.credits).toEqual({
      balance: "1234",
      has_credits: true,
      unlimited: false,
      available_resets: 2,
      description: null,
    });
    expect(result.buckets.map((bucket) => bucket.label)).toEqual([
      "5 小时",
      "7 天",
    ]);
    expect(result.buckets[0]?.remaining_percent).toBe(62.5);
    expect(result.buckets[1]?.remaining_percent).toBe(88);
  });

  it("returns unavailable and error placeholders with provider metadata", () => {
    expect(unavailableQuota(new Date("2026-08-17T00:00:00.000Z"), "not here"))
      .toMatchObject({ provider: "codex", status: "unavailable", message: "not here" });
    expect(quotaError(new Date("2026-08-17T00:00:00.000Z"), "boom"))
      .toMatchObject({ provider: "codex", status: "error", message: "boom" });
  });
});

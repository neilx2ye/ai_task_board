import { describe, expect, it } from "vitest";

import { normalizeAntigravityQuota } from "../../packages/antigravity-bridge/src/quota";

describe("normalizeAntigravityQuota", () => {
  it("maps model-family buckets into normalized windows", () => {
    const result = normalizeAntigravityQuota(
      {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-5h",
                displayName: "Five Hour Limit",
                remainingFraction: 0.625,
                resetTime: "2026-08-17T04:00:00Z",
              },
              {
                bucketId: "gemini-weekly",
                displayName: "Weekly Limit",
                remainingFraction: 0.95,
                resetTime: "2026-08-23T00:00:00Z",
              },
            ],
          },
        ],
      },
      "Google AI Pro",
      new Date("2026-08-17T00:00:00.000Z"),
    );

    expect(result.status).toBe("ok");
    expect(result.plan).toBe("Google AI Pro");
    expect(result.buckets[0]).toMatchObject({
      id: "Gemini Models:gemini-5h",
      label: "Five Hour Limit",
      description: "Gemini Models",
      remaining_percent: 62.5,
      used_percent: 37.5,
    });
    expect(result.buckets[1]?.remaining_percent).toBe(95);
  });

  it("reports unavailable when no buckets are returned", () => {
    const result = normalizeAntigravityQuota(
      { groups: [] },
      null,
      new Date("2026-08-17T00:00:00.000Z"),
    );
    expect(result.status).toBe("unavailable");
    expect(result.buckets).toEqual([]);
  });
});

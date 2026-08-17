import { describe, expect, it } from "vitest";

import { normalizeKimiQuota } from "../../packages/kimi-bridge/src/quota";

describe("normalizeKimiQuota", () => {
  it("normalizes the weekly usage and five-hour rate limit", () => {
    const result = normalizeKimiQuota(
      {
        usage: {
          limit: "2048",
          used: "214",
          remaining: "1834",
          resetTime: "2026-08-23T00:00:00Z",
        },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: "200",
              used: "139",
              remaining: "61",
              resetTime: "2026-08-17T04:00:00Z",
            },
          },
        ],
      },
      new Date("2026-08-17T00:00:00.000Z"),
    );

    expect(result.provider).toBe("kimi");
    expect(result.status).toBe("ok");
    expect(result.buckets[0]).toMatchObject({
      label: "周期额度",
      limit: 2048,
      used: 214,
      remaining: 1834,
    });
    expect(result.buckets[1]).toMatchObject({
      label: "300 分钟限额",
      limit: 200,
      used: 139,
      remaining: 61,
      remaining_percent: 30.5,
    });
  });

  it("returns an error when the payload has no recognizable shape", () => {
    expect(normalizeKimiQuota(null, new Date("2026-08-17T00:00:00.000Z")))
      .toMatchObject({ provider: "kimi", status: "error" });
  });
});

import { describe, expect, it } from "vitest";

import { parseConnectionQuota } from "@/lib/domain/connection-quota";

describe("parseConnectionQuota", () => {
  it("parses a normalized provider snapshot", () => {
    expect(
      parseConnectionQuota({
        provider: "codex",
        status: "ok",
        message: null,
        account: null,
        plan: "pro",
        fetched_at: "2026-08-17T00:00:00.000Z",
        buckets: [
          {
            id: "primary",
            label: "5 小时",
            remaining_percent: 62.5,
            used_percent: 37.5,
            limit: null,
            used: null,
            remaining: null,
            resets_at: "2026-08-17T04:00:00.000Z",
            unlimited: false,
            description: null,
          },
        ],
        credits: null,
      }),
    ).toEqual({
      provider: "codex",
      status: "ok",
      message: null,
      account: null,
      plan: "pro",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      buckets: [
        {
          id: "primary",
          label: "5 小时",
          remainingPercent: 62.5,
          usedPercent: 37.5,
          limit: null,
          used: null,
          remaining: null,
          resetsAt: "2026-08-17T04:00:00.000Z",
          unlimited: false,
          description: null,
        },
      ],
      credits: null,
    });
  });

  it("returns null for missing or malformed snapshots", () => {
    expect(parseConnectionQuota(null)).toBeNull();
    expect(parseConnectionQuota({})).toBeNull();
    expect(
      parseConnectionQuota({
        provider: "codex",
        status: "ok",
        message: null,
        account: null,
        plan: null,
        fetched_at: "2026-08-17T00:00:00.000Z",
        buckets: [{}],
        credits: null,
      }),
    ).toBeNull();
  });
});

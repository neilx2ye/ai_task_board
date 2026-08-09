import { describe, expect, it } from "vitest";

import {
  effectiveSessionStatus,
  isSessionAlive,
  SESSION_ALIVE_WINDOW_MS,
} from "@/lib/domain/session-presence";

const now = Date.parse("2026-08-08T12:00:00.000Z");

describe("session presence", () => {
  it("keeps a recently seen non-offline session alive", () => {
    const session = {
      status: "busy" as const,
      last_seen_at: new Date(now - SESSION_ALIVE_WINDOW_MS).toISOString(),
    };
    expect(isSessionAlive(session, now)).toBe(true);
    expect(effectiveSessionStatus(session, now)).toBe("busy");
  });

  it("treats stale or explicitly offline sessions as offline", () => {
    expect(
      isSessionAlive(
        {
          status: "online",
          last_seen_at: new Date(now - SESSION_ALIVE_WINDOW_MS - 1).toISOString(),
        },
        now,
      ),
    ).toBe(false);
    expect(
      effectiveSessionStatus(
        { status: "offline", last_seen_at: new Date(now).toISOString() },
        now,
      ),
    ).toBe("offline");
  });

  it("rejects malformed timestamps", () => {
    expect(isSessionAlive({ status: "online", last_seen_at: "invalid" }, now)).toBe(
      false,
    );
  });
});

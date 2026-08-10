import { describe, expect, it } from "vitest";

import {
  CONNECTION_ALIVE_WINDOW_MS,
  effectiveSessionStatus,
  isConnectionAlive,
  isSessionAlive,
  SESSION_ALIVE_WINDOW_MS,
} from "@/lib/domain/session-presence";

const now = Date.parse("2026-08-08T12:00:00.000Z");

describe("session presence", () => {
  it("derives Bridge device presence from its explicit heartbeat", () => {
    expect(
      isConnectionAlive(
        {
          last_seen_at: new Date(now - CONNECTION_ALIVE_WINDOW_MS).toISOString(),
          revoked_at: null,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isConnectionAlive(
        {
          last_seen_at: new Date(
            now - CONNECTION_ALIVE_WINDOW_MS - 1,
          ).toISOString(),
          revoked_at: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isConnectionAlive(
        { last_seen_at: new Date(now).toISOString(), revoked_at: new Date(now).toISOString() },
        now,
      ),
    ).toBe(false);
  });

  it("keeps a recently seen non-offline session alive", () => {
    const session = {
      archived_at: null,
      inventory_active: true,
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
          archived_at: null,
          inventory_active: true,
          status: "online",
          last_seen_at: new Date(now - SESSION_ALIVE_WINDOW_MS - 1).toISOString(),
        },
        now,
      ),
    ).toBe(false);
    expect(
      effectiveSessionStatus(
        {
          archived_at: null,
          inventory_active: true,
          status: "offline",
          last_seen_at: new Date(now).toISOString(),
        },
        now,
      ),
    ).toBe("offline");
  });

  it("keeps omitted and archived inventory sessions offline despite fresh status", () => {
    const fresh = {
      last_seen_at: new Date(now).toISOString(),
      status: "online" as const,
    };
    expect(
      isSessionAlive(
        { ...fresh, archived_at: null, inventory_active: false },
        now,
      ),
    ).toBe(false);
    expect(
      effectiveSessionStatus(
        {
          ...fresh,
          archived_at: new Date(now).toISOString(),
          inventory_active: true,
        },
        now,
      ),
    ).toBe("offline");
  });

  it("rejects malformed timestamps", () => {
    expect(
      isSessionAlive(
        {
          archived_at: null,
          inventory_active: true,
          status: "online",
          last_seen_at: "invalid",
        },
        now,
      ),
    ).toBe(false);
  });
});

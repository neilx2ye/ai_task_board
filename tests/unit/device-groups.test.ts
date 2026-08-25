import { describe, expect, it } from "vitest";

import type { PublicConnection } from "@/hooks/use-connections";
import { groupConnectionsByDevice } from "@/lib/domain/device-groups";

function connection(
  overrides: Partial<PublicConnection> = {},
): PublicConnection {
  return {
    id: "conn-1",
    workspace_id: "ws-1",
    name: "Laptop Codex",
    platform: "Codex",
    created_by_user_id: null,
    last_used_at: null,
    last_seen_at: null,
    bridge_version: null,
    created_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

describe("groupConnectionsByDevice", () => {
  it("merges connections that report the same device id", () => {
    const groups = groupConnectionsByDevice([
      connection({
        id: "a",
        name: "Codex",
        device_id: "device-1",
        device_label: "laptop",
      }),
      connection({
        id: "b",
        name: "Kimi",
        device_id: "device-1",
        device_label: "laptop",
      }),
      connection({
        id: "c",
        name: "Desktop Codex",
        device_id: "device-2",
        device_label: "desktop",
      }),
    ]);

    expect(groups).toHaveLength(2);
    const laptop = groups.find((group) => group.deviceId === "device-1");
    expect(laptop).toMatchObject({ label: "laptop", reported: true });
    expect(laptop?.connections.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("degrades unreported legacy bridges into single-bridge devices", () => {
    const groups = groupConnectionsByDevice([
      connection({ id: "a", name: "Codex" }),
      connection({ id: "b", name: "Kimi" }),
    ]);

    expect(groups.map((group) => group.deviceId)).toEqual([
      "connection:a",
      "connection:b",
    ]);
    expect(groups.every((group) => !group.reported)).toBe(true);
    expect(groups.map((group) => group.label)).toEqual(["Codex", "Kimi"]);
  });

  it("prefers a reported device label over connection names", () => {
    const groups = groupConnectionsByDevice([
      connection({ id: "a", name: "Codex", device_id: "device-1" }),
      connection({
        id: "b",
        name: "Kimi",
        device_id: "device-1",
        device_label: "laptop",
      }),
    ]);

    expect(groups[0]?.label).toBe("laptop");
  });
});

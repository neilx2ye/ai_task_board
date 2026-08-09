import { describe, expect, it } from "vitest";

import {
  activeConnections,
  type PublicConnection,
} from "@/hooks/use-connections";

function connection(
  overrides: Partial<PublicConnection> = {},
): PublicConnection {
  return {
    id: "conn-1",
    workspace_id: "ws-1",
    name: "Claude 桌面端",
    platform: "Claude",
    created_by_user_id: null,
    last_used_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

describe("activeConnections", () => {
  it("保留 revoked_at 为 null 的连接", () => {
    const active = connection({ id: "active" });
    expect(activeConnections([active])).toEqual([active]);
  });

  it("丢弃 revoked_at 非 null 的连接", () => {
    const revoked = connection({
      id: "revoked",
      revoked_at: "2026-02-01T00:00:00.000Z",
    });
    expect(activeConnections([revoked])).toEqual([]);
  });

  it("混合列表只返回有效连接且保持顺序", () => {
    const first = connection({ id: "a" });
    const revoked = connection({ id: "b", revoked_at: "2026-02-01T00:00:00.000Z" });
    const second = connection({ id: "c" });
    expect(activeConnections([first, revoked, second]).map((c) => c.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("空输入返回空数组", () => {
    expect(activeConnections([])).toEqual([]);
  });
});

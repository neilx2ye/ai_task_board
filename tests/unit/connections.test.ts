import { describe, expect, it } from "vitest";

import {
  activeConnections,
  bridgeVersionForPlatform,
  supportsManagedDirectoryCreation,
  supportsRemoteBridgeUpdate,
  supportsWorkingDirectoryInventory,
  supportsWebThreadManagement,
  supportsWebThreadRename,
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
    last_seen_at: null,
    bridge_version: null,
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

  it.each([
    ["0.5.0", true],
    ["0.12.3", true],
    ["1.0.0", true],
    ["0.4.99", false],
    ["dev", false],
    [null, false],
  ])("识别 Bridge %s 的 Web Thread 管理能力", (bridgeVersion, expected) => {
    expect(
      supportsWebThreadManagement(
        connection({ bridge_version: bridgeVersion as string | null }),
      ),
    ).toBe(expected);
  });

  it.each([
    ["0.7.0", true],
    ["0.12.3", true],
    ["1.0.0", true],
    ["0.6.99", false],
    ["dev", false],
    [null, false],
  ])("识别 Bridge %s 的多工作目录能力", (bridgeVersion, expected) => {
    expect(
      supportsWorkingDirectoryInventory(
        connection({ bridge_version: bridgeVersion as string | null }),
      ),
    ).toBe(expected);
  });

  it("对 Kimi Bridge 启用创建和删除，但隐藏 ACP 不支持的改名", () => {
    const kimi = connection({
      platform: "Kimi Code",
      bridge_version: "0.9.0-kimi.1",
    });
    expect(supportsWebThreadManagement(kimi)).toBe(true);
    expect(supportsWebThreadRename(kimi)).toBe(false);
    expect(
      supportsWebThreadRename(
        connection({ platform: "Codex", bridge_version: "0.9.0" }),
      ),
    ).toBe(true);
  });

  it.each([
    ["1.3.0", true],
    ["1.3.0-kimi.1", true],
    ["2.0.0", true],
    ["1.2.0", false],
    ["0.9.0", false],
    ["dev", false],
    [null, false],
  ])("识别 Bridge %s 的设备端建目录能力", (bridgeVersion, expected) => {
    expect(
      supportsManagedDirectoryCreation(
        connection({ bridge_version: bridgeVersion as string | null }),
      ),
    ).toBe(expected);
  });

  it.each([
    ["1.5.0", true],
    ["1.5.0-kimi.1", true],
    ["1.8.1-kimi.1", true],
    ["1.5.0-antigravity.1", true],
    ["2.0.0", true],
    ["1.4.0", false],
    ["1.3.0", false],
    ["0.9.0", false],
    ["dev", false],
    [null, false],
  ])("识别 Bridge %s 的远程自更新能力", (bridgeVersion, expected) => {
    expect(
      supportsRemoteBridgeUpdate(
        connection({ bridge_version: bridgeVersion as string | null }),
      ),
    ).toBe(expected);
  });
});

describe("bridgeVersionForPlatform", () => {
  it("reads the matching runtime entry of a unified connection", () => {
    expect(
      bridgeVersionForPlatform(
        connection({
          platform: "All",
          bridge_version: "1.8.1-claude.1",
          bridge_versions: [
            { platform: "codex", bridge_version: "1.8.1" },
            { platform: "kimi", bridge_version: "1.8.1-kimi.1" },
          ],
        }),
        "kimi",
      ),
    ).toBe("1.8.1-kimi.1");
  });

  it("returns null for a unified runtime that has not reported", () => {
    expect(
      bridgeVersionForPlatform(
        connection({
          platform: "All",
          bridge_version: "1.8.1-claude.1",
          bridge_versions: [{ platform: "codex", bridge_version: "1.8.1" }],
        }),
        "kimi",
      ),
    ).toBeNull();
  });

  it("falls back to the connection-level version for single-runtime links", () => {
    expect(
      bridgeVersionForPlatform(
        connection({ bridge_version: "1.8.1-claude.1" }),
        "claude",
      ),
    ).toBe("1.8.1-claude.1");
  });
});

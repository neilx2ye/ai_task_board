import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const ownerContext = { role: "owner" as const, userId, workspaceId };
const memberContext = { role: "member" as const, userId, workspaceId };

const adminMocks = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  maybeSingle: vi.fn(),
}));
const releaseMocks = vi.hoisted(() => ({
  bridgeReleaseExists: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: adminMocks.from }),
}));
vi.mock("@/lib/bridge-release", () => ({
  bridgeReleaseExists: releaseMocks.bridgeReleaseExists,
}));

import { setBridgeUpdateTarget } from "@/lib/domain/bridge-update";

function mockConnection(bridgeVersion: string | null) {
  let call = 0;
  adminMocks.maybeSingle.mockReset().mockImplementation(() => {
    call += 1;
    return Promise.resolve(
      call % 2 === 1
        ? {
      data: {
        id: connectionId,
        platform: "Claude",
        bridge_version: bridgeVersion,
      },
      error: null,
          }
        : {
            data: {
              platform: "claude",
              bridge_version: bridgeVersion,
              desired_bridge_version: null,
            },
            error: null,
          },
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    error: null,
    select: adminMocks.select,
    update: adminMocks.update,
    upsert: adminMocks.upsert,
    eq: adminMocks.eq,
    is: adminMocks.is,
    maybeSingle: adminMocks.maybeSingle,
  };
  adminMocks.from.mockReturnValue(chain);
  adminMocks.select.mockReturnValue(chain);
  adminMocks.update.mockReturnValue(chain);
  adminMocks.upsert.mockReturnValue(chain);
  adminMocks.eq.mockReturnValue(chain);
  adminMocks.is.mockReturnValue(chain);
  mockConnection("1.3.0");
  releaseMocks.bridgeReleaseExists.mockResolvedValue(true);
});

describe("setBridgeUpdateTarget", () => {
  it("owner 为已发布的更高版本写入期望版本", async () => {
    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: "1.4.0",
      }),
    ).resolves.toEqual({ desired_bridge_version: "1.4.0" });

    expect(adminMocks.from).toHaveBeenCalledWith(
      "ai_connection_bridge_settings",
    );
    expect(adminMocks.upsert).toHaveBeenCalledWith(
      {
        workspace_id: workspaceId,
        connection_id: connectionId,
        platform: "claude",
        desired_bridge_version: "1.4.0",
      },
      { onConflict: "connection_id,platform" },
    );
    expect(adminMocks.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(adminMocks.eq).toHaveBeenCalledWith("connection_id", connectionId);
    expect(adminMocks.eq).toHaveBeenCalledWith("platform", "claude");
  });

  it("拒绝非 owner", async () => {
    await expect(
      setBridgeUpdateTarget(memberContext, connectionId, {
        target_version: "1.4.0",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(adminMocks.from).not.toHaveBeenCalled();
  });

  it("连接不存在或已撤销时拒绝", async () => {
    adminMocks.maybeSingle
      .mockReset()
      .mockResolvedValue({ data: null, error: null });

    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: "1.4.0",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(adminMocks.update).not.toHaveBeenCalled();
  });

  it("target 为 null 时清除期望版本且不查询 registry", async () => {
    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: null,
      }),
    ).resolves.toEqual({ desired_bridge_version: null });

    expect(adminMocks.update).toHaveBeenCalledWith({
      desired_bridge_version: null,
    });
    expect(adminMocks.eq).toHaveBeenCalledWith("platform", "claude");
    expect(releaseMocks.bridgeReleaseExists).not.toHaveBeenCalled();
  });

  it.each(["latest", "1.4", "1.4.0; drop table", "../etc"])(
    "拒绝非法版本字符串 %j",
    async (target) => {
      await expect(
        setBridgeUpdateTarget(ownerContext, connectionId, {
          target_version: target,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
      expect(adminMocks.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["等于当前", "1.3.0"],
    ["低于当前", "1.2.9"],
  ])("拒绝%s的版本", async (_label, target) => {
    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: target,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(releaseMocks.bridgeReleaseExists).not.toHaveBeenCalled();
    expect(adminMocks.update).not.toHaveBeenCalled();
  });

  it("Bridge 尚未上报版本时无法比较，拒绝", async () => {
    mockConnection(null);

    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: "1.4.0",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(adminMocks.update).not.toHaveBeenCalled();
  });

  it("目标版本在 npm 上不存在时拒绝", async () => {
    releaseMocks.bridgeReleaseExists.mockResolvedValue(false);

    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: "1.4.0",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(releaseMocks.bridgeReleaseExists).toHaveBeenCalledWith("1.4.0");
    expect(adminMocks.update).not.toHaveBeenCalled();
  });

  it("当前版本带运行时后缀时按基版本比较", async () => {
    mockConnection("1.4.0-kimi.1");

    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: "1.4.0",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: "1.4.1",
      }),
    ).resolves.toEqual({ desired_bridge_version: "1.4.1" });
  });

  it("统一设备连接按输入平台取对应运行时的版本", async () => {
    adminMocks.maybeSingle
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          id: connectionId,
          platform: "All",
          bridge_version: "1.7.1-claude.1",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          platform: "kimi",
          bridge_version: "1.7.1-kimi.1",
          desired_bridge_version: null,
        },
        error: null,
      });

    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: "1.8.0",
        platform: "kimi",
      }),
    ).resolves.toEqual({ desired_bridge_version: "1.8.0" });

    expect(adminMocks.upsert).toHaveBeenCalledWith(
      {
        workspace_id: workspaceId,
        connection_id: connectionId,
        platform: "kimi",
        desired_bridge_version: "1.8.0",
      },
      { onConflict: "connection_id,platform" },
    );
  });

  it("统一设备连接不能借用其他运行时的版本，未上报时拒绝", async () => {
    adminMocks.maybeSingle
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          id: connectionId,
          platform: "All",
          bridge_version: "1.7.1-claude.1",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          platform: "kimi",
          bridge_version: null,
          desired_bridge_version: null,
        },
        error: null,
      });

    await expect(
      setBridgeUpdateTarget(ownerContext, connectionId, {
        target_version: "1.8.0",
        platform: "kimi",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(adminMocks.upsert).not.toHaveBeenCalled();
  });
});

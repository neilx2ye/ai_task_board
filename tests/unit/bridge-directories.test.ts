import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const databaseMocks = vi.hoisted(() => {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
  };
  return {
    from: vi.fn(),
    query,
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: databaseMocks.from }),
}));

import { listBridgeDirectories } from "@/lib/domain/bridge-directories";

const context = {
  role: "member" as const,
  userId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  vi.clearAllMocks();
  databaseMocks.from.mockReturnValue(databaseMocks.query);
  databaseMocks.query.select.mockReturnValue(databaseMocks.query);
  databaseMocks.query.eq.mockReturnValue(databaseMocks.query);
  databaseMocks.query.order.mockReturnValue(databaseMocks.query);
});

describe("Bridge directory inventory compatibility", () => {
  it.each(["PGRST205", "42P01"])(
    "returns an empty inventory while the directory migration is missing (%s)",
    async (code) => {
      databaseMocks.query.range.mockResolvedValue({
        data: null,
        error: {
          code,
          message:
            "Could not find the table 'public.ai_bridge_directories' in the schema cache",
        },
      });

      await expect(listBridgeDirectories(context)).resolves.toEqual({
        directories: [],
      });
    },
  );

  it("does not hide unrelated database failures", async () => {
    databaseMocks.query.range.mockResolvedValue({
      data: null,
      error: { code: "08006", message: "connection failure" },
    });

    await expect(listBridgeDirectories(context)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
    });
  });
});

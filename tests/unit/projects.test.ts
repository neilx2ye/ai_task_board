import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const adminState = vi.hoisted(() => ({
  connectionsRows: [] as { id: string; name: string }[],
  settingsRow: null as Record<string, unknown> | null,
}));
const updateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "ai_connections") {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                in: () =>
                  Promise.resolve({
                    data: adminState.connectionsRows,
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: adminState.settingsRow, error: null }),
            }),
          }),
        }),
      };
    },
  }),
}));
vi.mock("@/lib/domain/bridge-config", () => ({
  updateBridgeConfiguration: updateMock,
}));

import {
  createProjectOnBridges,
  deriveDirectoryKey,
} from "@/lib/domain/projects";
import { AppError } from "@/lib/domain/errors";
import { bridgeWorkingDirectoriesSchema } from "@/lib/validation/bridge-config";
import { createProjectSchema } from "@/lib/validation/projects";

const ownerContext = {
  role: "owner" as const,
  userId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const connectionId = "33333333-3333-4333-8333-333333333333";

const baseInput = {
  name: "Main app",
  working_directory: "/srv/main",
  connection_ids: [connectionId],
};

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    version: 4,
    desired_enabled: true,
    desired_include_thread_titles: false,
    desired_max_threads: 50,
    desired_max_concurrent_turns: 2,
    desired_sync_history: false,
    desired_history_turn_limit: 50,
    desired_working_directories: null,
    effective_working_directories: [
      {
        directory_key: "default",
        name: "Default",
        working_directory: "/srv/default",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  adminState.connectionsRows = [{ id: connectionId, name: "Laptop" }];
  adminState.settingsRow = settingsRow();
  updateMock.mockResolvedValue({});
});

describe("deriveDirectoryKey", () => {
  it("slugifies the project name", () => {
    expect(deriveDirectoryKey("My App", new Set())).toBe("my-app");
    expect(deriveDirectoryKey("我的项目", new Set())).toBe("project");
    expect(deriveDirectoryKey("..dot", new Set())).toBe("dot");
  });

  it("deduplicates against existing keys", () => {
    expect(deriveDirectoryKey("Main", new Set(["main"]))).toBe("main-2");
    expect(deriveDirectoryKey("Main", new Set(["main", "main-2"]))).toBe(
      "main-3",
    );
  });
});

describe("createProjectSchema", () => {
  it("accepts POSIX and Windows absolute paths", () => {
    expect(createProjectSchema.parse(baseInput).working_directory).toBe(
      "/srv/main",
    );
    expect(
      createProjectSchema.parse({
        ...baseInput,
        working_directory: "C:\\projects\\main",
      }).working_directory,
    ).toBe("C:\\projects\\main");
  });

  it("rejects relative paths and empty connection lists", () => {
    expect(() =>
      createProjectSchema.parse({ ...baseInput, working_directory: "srv/main" }),
    ).toThrow();
    expect(() =>
      createProjectSchema.parse({ ...baseInput, connection_ids: [] }),
    ).toThrow();
  });
});

describe("bridgeWorkingDirectoriesSchema create_if_missing", () => {
  it("accepts the optional create flag and still rejects unknown fields", () => {
    const parsed = bridgeWorkingDirectoriesSchema.parse([
      {
        directory_key: "main",
        name: "Main",
        working_directory: "/srv/main",
        create_if_missing: true,
      },
    ]);
    expect(parsed?.[0]?.create_if_missing).toBe(true);

    expect(() =>
      bridgeWorkingDirectoriesSchema.parse([
        {
          directory_key: "main",
          name: "Main",
          working_directory: "/srv/main",
          create_if_missing: "yes",
        },
      ]),
    ).toThrow();
    expect(() =>
      bridgeWorkingDirectoriesSchema.parse([
        {
          directory_key: "main",
          name: "Main",
          working_directory: "/srv/main",
          unexpected: true,
        },
      ]),
    ).toThrow();
  });
});

describe("createProjectOnBridges", () => {
  it("appends the create-authorized entry onto the effective baseline", async () => {
    const response = await createProjectOnBridges(
      ownerContext,
      baseInput,
      "web/projects/test",
    );

    expect(response.results).toEqual([
      {
        connection_id: connectionId,
        connection_name: "Laptop",
        status: "submitted",
      },
    ]);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [, targetConnection, input, key] = updateMock.mock.calls[0]!;
    expect(targetConnection).toBe(connectionId);
    expect(input).toMatchObject({
      expected_version: 4,
      working_directories: [
        { directory_key: "default", name: "Default", working_directory: "/srv/default" },
        {
          directory_key: "main-app",
          name: "Main app",
          working_directory: "/srv/main",
          create_if_missing: true,
        },
      ],
    });
    expect(key).toBe(`web/projects/test:${connectionId}`);
  });

  it("prefers the desired list over the effective report", async () => {
    adminState.settingsRow = settingsRow({
      desired_working_directories: [
        {
          directory_key: "web",
          name: "Web",
          working_directory: "/srv/web",
        },
      ],
    });

    await createProjectOnBridges(ownerContext, baseInput, "k");

    const [, , input] = updateMock.mock.calls[0]!;
    expect(
      input.working_directories.map(
        (directory: { directory_key: string }) => directory.directory_key,
      ),
    ).toEqual(["web", "main-app"]);
  });

  it("skips bridges whose list already contains the path", async () => {
    adminState.settingsRow = settingsRow({
      desired_working_directories: [
        {
          directory_key: "main",
          name: "Main",
          working_directory: "/srv/main",
        },
      ],
    });

    const response = await createProjectOnBridges(
      ownerContext,
      baseInput,
      "k",
    );

    expect(response.results[0]).toMatchObject({
      status: "skipped",
      reason: "该项目已在目录清单中",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("skips bridges without any reported directory list", async () => {
    adminState.settingsRow = settingsRow({
      effective_working_directories: null,
    });

    const response = await createProjectOnBridges(
      ownerContext,
      baseInput,
      "k",
    );

    expect(response.results[0]?.status).toBe("skipped");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("retries once with a fresh idempotency key on version conflict", async () => {
    updateMock
      .mockRejectedValueOnce(new AppError("VERSION_CONFLICT", "conflict"))
      .mockResolvedValueOnce({});

    const response = await createProjectOnBridges(
      ownerContext,
      baseInput,
      "k",
    );

    expect(response.results[0]?.status).toBe("submitted");
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[1]![3]).toBe(`k:${connectionId}:retry`);
  });

  it("fails unknown connections without touching the RPC", async () => {
    const missingId = "99999999-9999-4999-8999-999999999999";

    const response = await createProjectOnBridges(
      ownerContext,
      { ...baseInput, connection_ids: [missingId] },
      "k",
    );

    expect(response.results[0]).toMatchObject({
      connection_id: missingId,
      status: "failed",
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});

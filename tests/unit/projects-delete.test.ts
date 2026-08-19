import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  updateConfig: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("@/lib/domain/bridge-config", () => ({
  updateBridgeConfiguration: state.updateConfig,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let mode: "select" | "update" | "delete" = "select";
      let payload: Record<string, unknown> | null = null;
      const filters: { column: string; value: unknown; isNull?: boolean }[] =
        [];

      const execute = () => {
        const rows = (state.tables[table] ?? []).filter((row) =>
          filters.every((filter) =>
            filter.isNull
              ? row[filter.column] === null
              : row[filter.column] === filter.value,
          ),
        );
        if (mode === "delete") {
          state.tables[table] = (state.tables[table] ?? []).filter(
            (row) => !rows.includes(row),
          );
          return { data: rows, error: null };
        }
        if (mode === "update") {
          for (const row of rows) Object.assign(row, payload ?? {});
          return { data: rows, error: null };
        }
        return { data: rows, error: null };
      };

      const builder = {
        select: () => builder,
        update: (value: Record<string, unknown>) => {
          mode = "update";
          payload = value;
          return builder;
        },
        delete: () => {
          mode = "delete";
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          return builder;
        },
        is: (column: string, value: unknown) => {
          filters.push({ column, value, isNull: value === null });
          return builder;
        },
        maybeSingle: async () => {
          const result = execute();
          return {
            data: result.data[0] ?? null,
            error: result.error,
          };
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(execute()).then(resolve),
      };
      return builder;
    },
  }),
}));

import { deleteProjectOnBridges } from "@/lib/domain/projects";
import { AppError } from "@/lib/domain/errors";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const ownerContext = {
  role: "owner" as const,
  userId,
  workspaceId,
};

const mainDirectory = {
  directory_key: "main",
  name: "Main",
  working_directory: "/srv/main",
};
const docsDirectory = {
  directory_key: "docs",
  name: "Docs",
  working_directory: "/srv/docs",
};

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: workspaceId,
    connection_id: connectionId,
    platform: "codex",
    version: 4,
    desired_enabled: true,
    desired_include_thread_titles: false,
    desired_max_threads: 50,
    desired_max_concurrent_turns: 2,
    desired_sync_history: false,
    desired_history_turn_limit: 50,
    desired_working_directories: null,
    effective_working_directories: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updateConfig.mockResolvedValue({});
  state.tables = {
    ai_connections: [
      {
        id: connectionId,
        workspace_id: workspaceId,
        name: "Laptop",
        revoked_at: null,
      },
    ],
    ai_connection_bridge_settings: [
      settingsRow({
        desired_working_directories: [mainDirectory, docsDirectory],
      }),
    ],
    ai_bridge_directories: [
      {
        workspace_id: workspaceId,
        connection_id: connectionId,
        platform: "codex",
        ...mainDirectory,
      },
    ],
    ai_sessions: [
      {
        id: "session-1",
        workspace_id: workspaceId,
        connection_id: connectionId,
        platform: "codex",
        bridge_directory_key: "main",
        working_directory: "/srv/main",
        inventory_active: true,
        status: "online",
      },
      {
        id: "session-2",
        workspace_id: workspaceId,
        connection_id: connectionId,
        platform: "codex",
        bridge_directory_key: null,
        working_directory: "/srv/main",
        inventory_active: true,
        status: "online",
      },
    ],
    ai_thread_commands: [
      {
        id: "command-1",
        workspace_id: workspaceId,
        connection_id: connectionId,
        platform: "codex",
        directory_key: "main",
      },
    ],
  };
});

describe("deleteProjectOnBridges", () => {
  it("deletes directory records and stops Bridge management without deleting device files", async () => {
    const result = await deleteProjectOnBridges(
      ownerContext,
      { working_directory: "/srv/main" },
      "web/projects/delete",
    );

    expect(result.deleted_directory_rows).toBe(1);
    expect(result.detached_sessions).toBe(2);
    expect(result.results).toEqual([
      expect.objectContaining({
        connection_id: connectionId,
        status: "submitted",
      }),
    ]);
    expect(state.updateConfig).toHaveBeenCalledTimes(1);
    expect(state.updateConfig.mock.calls[0]?.[3]).toMatchObject({
      expected_version: 4,
      working_directories: [docsDirectory],
    });
    expect(state.updateConfig.mock.calls[0]?.[4]).toContain(":codex:delete");

    expect(state.tables.ai_bridge_directories).toEqual([]);
    expect(state.tables.ai_sessions).toEqual([
      expect.objectContaining({
        id: "session-1",
        bridge_directory_key: null,
        inventory_active: false,
        status: "offline",
      }),
      expect.objectContaining({
        id: "session-2",
        bridge_directory_key: null,
        inventory_active: false,
        status: "offline",
      }),
    ]);
    expect(state.tables.ai_thread_commands[0]).toMatchObject({
      directory_key: null,
    });
  });

  it("falls back to the device startup configuration when the last directory is removed", async () => {
    state.tables.ai_connection_bridge_settings = [
      settingsRow({
        desired_working_directories: [mainDirectory],
      }),
    ];

    const result = await deleteProjectOnBridges(
      ownerContext,
      { working_directory: "/srv/main" },
      "web/projects/delete",
    );

    expect(result.results[0]?.status).toBe("submitted");
    expect(state.updateConfig.mock.calls[0]?.[3]).toMatchObject({
      working_directories: null,
    });
    expect(state.tables.ai_bridge_directories).toEqual([]);
  });

  it("retries once when the Bridge configuration version conflicts", async () => {
    state.updateConfig
      .mockRejectedValueOnce(new AppError("VERSION_CONFLICT", "conflict"))
      .mockResolvedValueOnce({});

    const result = await deleteProjectOnBridges(
      ownerContext,
      { working_directory: "/srv/main" },
      "web/projects/delete",
    );

    expect(result.results[0]?.status).toBe("submitted");
    expect(state.updateConfig).toHaveBeenCalledTimes(2);
    expect(state.updateConfig.mock.calls[1]?.[4]).toContain(":retry");
  });
});

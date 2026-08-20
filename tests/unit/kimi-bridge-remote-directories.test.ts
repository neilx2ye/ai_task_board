import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoardClient,
  KIMI_BRIDGE_CAPABILITY_VERSION,
} from "../../packages/kimi-bridge/src/board-client";
import {
  loadConfiguration,
  parseRemoteWorkingDirectories,
  type KimiBridgeConfiguration,
} from "../../packages/kimi-bridge/src/config";
import { resolveRemoteConfiguration } from "../../packages/kimi-bridge/src/bridge";

function baseConfiguration(
  environment: Record<string, string> = {},
): KimiBridgeConfiguration {
  return loadConfiguration({
    AI_TASK_BOARD_URL: "https://board.example.com",
    AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_token_value",
    KIMI_WORKING_DIRECTORY: "/srv/app",
    ...environment,
  });
}

function desired(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    include_thread_titles: false,
    max_threads: 4,
    max_concurrent_turns: 2,
    sync_history: false,
    history_turn_limit: 50,
    working_directories: null as unknown,
    ...overrides,
  };
}

describe("Kimi Bridge remote working directories", () => {
  let temporaryDirectory: string | null = null;

  function baseDirectory(): string {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), "atb-kimi-dirs-"));
    return temporaryDirectory;
  }

  afterEach(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  it("always allows Web working directories and ignores the legacy opt-in env", () => {
    expect(baseConfiguration().allowRemoteWorkingDirectories).toBe(true);
    expect(
      baseConfiguration({
        KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
      }).allowRemoteWorkingDirectories,
    ).toBe(true);
    expect(
      baseConfiguration({
        KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "yes",
      }).allowRemoteWorkingDirectories,
    ).toBe(true);
  });

  it("applies a valid Web list without a device opt-in", () => {
    const root = baseDirectory();
    const webDirectory = path.join(root, "web-project");
    const configuration = baseConfiguration();
    const resolved = resolveRemoteConfiguration(
      configuration,
      desired({
        working_directories: [
          {
            directory_key: "web",
            name: "Web project",
            working_directory: webDirectory,
            create_if_missing: true,
          },
        ],
      }),
    );
    expect(resolved.warnings).toEqual([]);
    expect(resolved.effective.workingDirectories).toEqual(
      [{ key: "web", name: "Web project", workingDirectory: webDirectory }],
    );
    expect(existsSync(webDirectory)).toBe(true);
  });

  it("applies a valid remote list and preserves the immutable local fallback", () => {
    const root = baseDirectory();
    const webDirectory = path.join(root, "web-project");
    const configuration = baseConfiguration();
    const resolved = resolveRemoteConfiguration(
      configuration,
      desired({
        working_directories: [
          {
            directory_key: "web",
            name: "Web project",
            working_directory: webDirectory,
            create_if_missing: true,
          },
        ],
      }),
    );
    expect(resolved.warnings).toEqual([]);
    expect(resolved.effective.workingDirectories).toEqual([
      { key: "web", name: "Web project", workingDirectory: webDirectory },
    ]);
    expect(existsSync(webDirectory)).toBe(true);
    // The immutable local fallback is preserved for a later null desired list.
    expect(configuration.localWorkingDirectories[0]?.workingDirectory).toBe(
      "/srv/app",
    );

    const reset = resolveRemoteConfiguration(configuration, desired());
    expect(reset.effective.workingDirectories).toEqual(
      configuration.localWorkingDirectories,
    );
  });

  it("rejects invalid remote lists", () => {
    const configuration = baseConfiguration();
    expect(() =>
      resolveRemoteConfiguration(
        configuration,
        desired({
          working_directories: [
            {
              directory_key: "missing",
              name: "Missing",
              working_directory: path.join(baseDirectory(), "missing"),
            },
          ],
        }),
      ),
    ).toThrow("不存在或不是目录");
    expect(() =>
      resolveRemoteConfiguration(
        configuration,
        desired({ working_directories: [] }),
      ),
    ).toThrow("必须包含 1 到 100 个目录");
  });

  it("parses remote entries with the shared validation rules", () => {
    const root = baseDirectory();
    expect(
      parseRemoteWorkingDirectories([
        { directory_key: "app", name: "App", working_directory: root },
      ]),
    ).toEqual([{ key: "app", name: "App", workingDirectory: root }]);
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "app",
          name: "App",
          working_directory: root,
          create_if_missing: 1,
        },
      ]),
    ).toThrow("create_if_missing 必须是布尔值");
    expect(() =>
      parseRemoteWorkingDirectories([
        { directory_key: "app", name: "App", working_directory: "relative" },
      ]),
    ).toThrow("必须是绝对路径");
  });
});

describe("Kimi Bridge session sync device identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubBoardFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function syncBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it("sends flat device_id and device_label fields with the 1.8.0 capability version", async () => {
    const fetchMock = stubBoardFetch();
    const client = new BoardClient(baseConfiguration(), () => false, {
      deviceId: "2f4b91c0-0000-4000-8000-0000000000ab",
      deviceLabel: "test-host",
    });
    await client.syncSessions([], baseConfiguration().workingDirectories, [], undefined);
    const body = syncBody(fetchMock);
    expect(body.bridge_version).toBe("1.8.0-kimi.1");
    expect(KIMI_BRIDGE_CAPABILITY_VERSION).toBe("1.8.0-kimi.1");
    expect(body.device_id).toBe("2f4b91c0-0000-4000-8000-0000000000ab");
    expect(body.device_label).toBe("test-host");
    expect(body.directories).toEqual([
      {
        directory_key: "default",
        name: "app",
        working_directory: "/srv/app",
      },
    ]);
  });

  it("loads the persisted device identity by default", async () => {
    const configHome = mkdtempSync(path.join(tmpdir(), "atb-kimi-device-"));
    try {
      vi.stubEnv("XDG_CONFIG_HOME", configHome);
      const fetchMock = stubBoardFetch();
      const client = new BoardClient(baseConfiguration(), () => false);
      await client.syncSessions([], [], [], undefined);
      const body = syncBody(fetchMock);
      const persisted = readFileSync(
        path.join(configHome, "ai-task-board", "device-id"),
        "utf8",
      ).trim();
      expect(body.device_id).toBe(persisted);
      expect(body.device_label).toBeTruthy();

      const second = new BoardClient(baseConfiguration(), () => false);
      await second.syncSessions([], [], [], undefined);
      expect(syncBody(fetchMock).device_id).toBe(persisted);
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

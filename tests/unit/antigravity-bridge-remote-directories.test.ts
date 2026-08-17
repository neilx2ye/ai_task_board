import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANTIGRAVITY_BRIDGE_CAPABILITY_VERSION,
  BoardClient,
} from "../../packages/antigravity-bridge/src/board-client";
import {
  loadConfiguration,
  parseRemoteWorkingDirectories,
  type AntigravityBridgeConfiguration,
} from "../../packages/antigravity-bridge/src/config";
import { resolveRemoteConfiguration } from "../../packages/antigravity-bridge/src/bridge";

function baseConfiguration(
  environment: Record<string, string> = {},
): AntigravityBridgeConfiguration {
  return loadConfiguration({
    AI_TASK_BOARD_URL: "https://board.example.com",
    AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_token_value",
    ANTIGRAVITY_WORKING_DIRECTORY: "/srv/app",
    ...environment,
  });
}

function desired(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    include_thread_titles: true,
    max_threads: 4,
    max_concurrent_turns: 2,
    sync_history: false,
    history_turn_limit: 50,
    working_directories: null as unknown,
    ...overrides,
  };
}

describe("Antigravity Bridge remote working directories", () => {
  let temporaryDirectory: string | null = null;

  function baseDirectory(): string {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), "atb-agy-dirs-"));
    return temporaryDirectory;
  }

  afterEach(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  it("parses the device opt-in environment variable", () => {
    expect(baseConfiguration().allowRemoteWorkingDirectories).toBe(false);
    expect(
      baseConfiguration({
        ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
      }).allowRemoteWorkingDirectories,
    ).toBe(true);
    expect(() =>
      baseConfiguration({
        ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "1",
      }),
    ).toThrow("布尔值必须是 true 或 false");
  });

  it("keeps the local startup list and warns when the device has not opted in", () => {
    const configuration = baseConfiguration();
    const resolved = resolveRemoteConfiguration(
      configuration,
      desired({
        working_directories: [
          {
            directory_key: "web",
            name: "Web project",
            working_directory: "/srv/web",
          },
        ],
      }),
    );
    expect(resolved.effective.workingDirectories).toEqual(
      configuration.localWorkingDirectories,
    );
    expect(resolved.warnings.join("")).toContain(
      "ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION",
    );
  });

  it("applies a valid remote list only when the device opted in", () => {
    const root = baseDirectory();
    const webDirectory = path.join(root, "web-project");
    const configuration = baseConfiguration({
      ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
    });
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
    expect(configuration.localWorkingDirectories[0]?.workingDirectory).toBe(
      "/srv/app",
    );

    const reset = resolveRemoteConfiguration(configuration, desired());
    expect(reset.effective.workingDirectories).toEqual(
      configuration.localWorkingDirectories,
    );
  });

  it("rejects invalid remote lists even when the device opted in", () => {
    const configuration = baseConfiguration({
      ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
    });
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
      parseRemoteWorkingDirectories([
        {
          directory_key: "app",
          name: "App",
          working_directory: "/srv/app",
          create_if_missing: "true",
        },
      ]),
    ).toThrow("create_if_missing 必须是布尔值");
  });
});

describe("Antigravity Bridge session sync device identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends flat device_id and device_label fields with the 1.3.0 capability version", async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BoardClient(baseConfiguration(), () => false, {
      deviceId: "7a1ce240-1111-4000-8000-0000000000cd",
      deviceLabel: "antigravity-host",
    });
    await client.syncSessions(
      [],
      baseConfiguration().workingDirectories,
      [],
      undefined,
    );
    const init = fetchMock.mock.calls[0]?.[1] as
      | { body?: string }
      | undefined;
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    expect(body.bridge_version).toBe("1.3.0-antigravity.1");
    expect(ANTIGRAVITY_BRIDGE_CAPABILITY_VERSION).toBe("1.3.0-antigravity.1");
    expect(body.device_id).toBe("7a1ce240-1111-4000-8000-0000000000cd");
    expect(body.device_label).toBe("antigravity-host");
  });
});

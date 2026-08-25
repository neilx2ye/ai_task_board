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

  it("always allows Web working directories and ignores the legacy opt-in env", () => {
    expect(baseConfiguration().allowRemoteWorkingDirectories).toBe(true);
    expect(
      baseConfiguration({
        ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
      }).allowRemoteWorkingDirectories,
    ).toBe(true);
    expect(
      baseConfiguration({
        ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "1",
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

  it("sends flat device_id and device_label fields with the current capability version", async () => {
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
    expect(body.bridge_version).toBe("1.8.8-antigravity.1");
    expect(ANTIGRAVITY_BRIDGE_CAPABILITY_VERSION).toBe("1.8.8-antigravity.1");
    expect(body.device_id).toBe("7a1ce240-1111-4000-8000-0000000000cd");
    expect(body.device_label).toBe("antigravity-host");
  });
});

describe("Antigravity Bridge task image download", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the private download endpoint and returns verified base64 bytes", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn(
      async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/ai/artifacts/1/download")) {
          return new Response(
            JSON.stringify({ data: { url: "https://storage.example/signed" } }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BoardClient(baseConfiguration(), () => false, {
      deviceId: "7a1ce240-1111-4000-8000-0000000000cd",
      deviceLabel: "antigravity-host",
    });
    const image = await client.downloadImage(
      "session-1",
      {
        id: "1",
        name: "screen.png",
        mime_type: "image/png",
        size: bytes.byteLength,
      },
      new AbortController().signal,
    );
    expect(image).toEqual({
      data: Buffer.from(bytes).toString("base64"),
      mimeType: "image/png",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects bytes that do not match the declared artifact size", async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn(
      async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/ai/artifacts/2/download")) {
          return new Response(
            JSON.stringify({ data: { url: "https://storage.example/signed" } }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BoardClient(baseConfiguration(), () => false);
    await expect(
      client.downloadImage(
        "session-1",
        {
          id: "2",
          name: "mismatch.png",
          mime_type: "image/png",
          size: 10,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("图片大小校验失败：mismatch.png");
  });
});

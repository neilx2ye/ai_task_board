import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildKimiInstallEnvironment,
  KIMI_BRIDGE_SYSTEMD_SERVICE,
  parseEnvironmentFile,
  renderSystemdUserUnit,
  resolveKimiDirectoryManagement,
  resolveSetupPaths,
  serializeEnvironmentFile,
} from "../../packages/kimi-bridge/src/setup";

describe("Kimi Bridge interactive setup primitives", () => {
  it("uses a separate service, secret file, and versioned runtime", () => {
    const paths = resolveSetupPaths("/home/alice", "0.1.0", {});
    expect(KIMI_BRIDGE_SYSTEMD_SERVICE).toBe(
      "ai-task-board-kimi-bridge.service",
    );
    expect(paths.environmentFile).toBe(
      "/home/alice/.config/ai-task-board/kimi-bridge.env",
    );
    expect(paths.runtimeCli).toBe(
      "/home/alice/.local/share/ai-task-board/kimi-bridge/versions/0.1.0/dist/cli.js",
    );
  });

  it("round-trips protected environment-file values", () => {
    const serialized = serializeEnvironmentFile({
      AI_TASK_BOARD_CONNECTION_TOKEN: 'atb_value_"quoted"',
      KIMI_WORKING_DIRECTORY: "/srv/My App",
    });
    expect(parseEnvironmentFile(serialized)).toEqual({
      AI_TASK_BOARD_CONNECTION_TOKEN: 'atb_value_"quoted"',
      KIMI_WORKING_DIRECTORY: "/srv/My App",
    });
  });

  it("renders a user unit that runs the pinned local runtime", () => {
    const unit = renderSystemdUserUnit({
      nodeBinary: "/usr/bin/node",
      runtimeCli: "/home/alice/.local/share/bridge/dist/cli.js",
      workingDirectory: "/srv/My App",
      homeDirectory: "/home/alice",
      environmentFile: "/home/alice/.config/board/kimi.env",
    });
    expect(unit).toContain("Description=AI Task Board Kimi Bridge");
    expect(unit).toContain("WorkingDirectory=/srv/My App");
    expect(unit).not.toContain("\\x20");
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/alice/.local/share/bridge/dist/cli.js" "run"',
    );
    expect(unit).not.toContain("npx");
    expect(path.isAbsolute("/usr/bin/node")).toBe(true);
  });
});

describe("Kimi Bridge 工作目录管理模式", () => {
  function buildEnvironment(
    overrides: Partial<Parameters<typeof buildKimiInstallEnvironment>[0]> = {},
  ) {
    return buildKimiInstallEnvironment({
      existing: {},
      boardUrl: "https://board.example.com",
      connectionToken: "atb_token",
      directoryManagement: "local",
      workingDirectory: "/srv/app",
      preserveMultipleDirectories: false,
      rawMultipleDirectories: undefined,
      agentMode: "auto",
      approvalMode: "decline",
      includeTitles: false,
      maxThreads: "50",
      maxConcurrentTurns: "5",
      webConfiguration: false,
      kimiBinary: "/usr/bin/kimi",
      pathValue: "/usr/bin:/bin",
      ...overrides,
    });
  }

  it("Web 管理模式写入两个开关并移除本机目录变量", () => {
    const environment = buildEnvironment({
      existing: {
        KIMI_WORKING_DIRECTORY: "/srv/legacy",
        KIMI_WORKING_DIRECTORIES: '[{"key":"old","path":"/srv/old"}]',
        CUSTOM_RETAINED: "keep",
      },
      directoryManagement: "web",
      workingDirectory: "/home/alice",
      webConfiguration: true,
    });

    expect(environment.KIMI_BRIDGE_WEB_CONFIG).toBe("true");
    expect(environment.KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION).toBe(
      "true",
    );
    expect(environment).not.toHaveProperty("KIMI_WORKING_DIRECTORY");
    expect(environment).not.toHaveProperty("KIMI_WORKING_DIRECTORIES");
    expect(environment.CUSTOM_RETAINED).toBe("keep");
  });

  it("本机固定目录模式保持现状：写工作目录、不写远程目录授权开关", () => {
    const environment = buildEnvironment({
      directoryManagement: "local",
      workingDirectory: "/srv/app",
    });

    expect(environment.KIMI_WORKING_DIRECTORY).toBe("/srv/app");
    expect(environment).not.toHaveProperty("KIMI_WORKING_DIRECTORIES");
    expect(environment).not.toHaveProperty(
      "KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION",
    );
    expect(environment.KIMI_BRIDGE_WEB_CONFIG).toBe("false");
  });

  it("本机固定目录模式保留现有多目录白名单", () => {
    const rawDirectories =
      '[{"key":"main","path":"/srv/main"},{"key":"docs","path":"/srv/docs"}]';
    const environment = buildEnvironment({
      directoryManagement: "local",
      workingDirectory: "/srv/main",
      preserveMultipleDirectories: true,
      rawMultipleDirectories: rawDirectories,
    });

    expect(environment.KIMI_WORKING_DIRECTORY).toBe("/srv/main");
    expect(environment.KIMI_WORKING_DIRECTORIES).toBe(rawDirectories);
  });

  it("重跑安装保留已开启的远程目录授权", () => {
    const environment = buildEnvironment({
      existing: {
        KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
      },
      directoryManagement: "local",
      workingDirectory: "/srv/app",
    });

    expect(environment.KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION).toBe(
      "true",
    );
    expect(environment.KIMI_WORKING_DIRECTORY).toBe("/srv/app");
  });

  it("非交互安装未提供目录变量时默认 Web 管理，unit 以用户主目录兜底", () => {
    const resolution = resolveKimiDirectoryManagement({
      homeDirectory: "/home/alice",
      configuredDirectory: undefined,
      rawMultipleDirectories: undefined,
    });

    expect(resolution).toEqual({
      directoryManagement: "web",
      workingDirectory: "/home/alice",
      preserveMultipleDirectories: false,
    });

    const unit = renderSystemdUserUnit({
      nodeBinary: "/usr/bin/node",
      runtimeCli: "/home/alice/.local/share/bridge/dist/cli.js",
      workingDirectory: resolution.workingDirectory,
      homeDirectory: "/home/alice",
      environmentFile: "/home/alice/.config/ai-task-board/kimi-bridge.env",
    });
    expect(unit).toContain("WorkingDirectory=/home/alice");
  });

  it("非交互安装提供目录变量时按本机固定目录安装", () => {
    expect(
      resolveKimiDirectoryManagement({
        homeDirectory: "/home/alice",
        configuredDirectory: "/srv/app",
        rawMultipleDirectories: undefined,
      }),
    ).toEqual({
      directoryManagement: "local",
      workingDirectory: "/srv/app",
      preserveMultipleDirectories: false,
    });

    expect(
      resolveKimiDirectoryManagement({
        homeDirectory: "/home/alice",
        configuredDirectory: undefined,
        rawMultipleDirectories:
          '[{"key":"main","path":"/srv/main"},{"key":"docs","path":"/srv/docs"}]',
      }),
    ).toEqual({
      directoryManagement: "local",
      workingDirectory: "/srv/main",
      preserveMultipleDirectories: true,
    });

    expect(() =>
      resolveKimiDirectoryManagement({
        homeDirectory: "/home/alice",
        configuredDirectory: undefined,
        rawMultipleDirectories: "not-json",
      }),
    ).toThrow("KIMI_WORKING_DIRECTORIES 无法解析");
  });
});

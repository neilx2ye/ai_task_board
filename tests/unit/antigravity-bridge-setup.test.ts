import { describe, expect, it } from "vitest";

import {
  buildAntigravityInstallEnvironment,
  parseEnvironmentFile,
  renderSystemdUserUnit,
  resolveAntigravityDirectoryManagement,
  resolveSetupPaths,
  serializeEnvironmentFile,
} from "@/packages/antigravity-bridge/src/setup";

describe("Antigravity Bridge setup paths and files", () => {
  it("resolves XDG-aware setup paths", () => {
    const paths = resolveSetupPaths("/home/alice", "1.2.3", {
      XDG_CONFIG_HOME: "/home/alice/.config",
      XDG_DATA_HOME: "/home/alice/.local/share",
    });
    expect(paths.environmentFile).toBe(
      "/home/alice/.config/ai-task-board/antigravity-bridge.env",
    );
    expect(paths.unitFile).toBe(
      "/home/alice/.config/systemd/user/ai-task-board-antigravity-bridge.service",
    );
    expect(paths.runtimeCli).toBe(
      "/home/alice/.local/share/ai-task-board/antigravity-bridge/versions/1.2.3/dist/cli.js",
    );
  });

  it("round-trips the environment file with quoting", () => {
    const serialized = serializeEnvironmentFile({
      AI_TASK_BOARD_URL: "https://board.example.com",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      ANTIGRAVITY_WORKING_DIRECTORY: "/srv/My App",
    });
    expect(serialized).toContain('ANTIGRAVITY_WORKING_DIRECTORY="/srv/My App"');
    expect(parseEnvironmentFile(serialized)).toEqual({
      AI_TASK_BOARD_URL: "https://board.example.com",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      ANTIGRAVITY_WORKING_DIRECTORY: "/srv/My App",
    });
  });

  it("renders a systemd unit that preserves literal bare paths", () => {
    const unit = renderSystemdUserUnit({
      nodeBinary: "/usr/bin/node",
      runtimeCli:
        "/home/alice/.local/share/ai-task-board/antigravity-bridge/versions/1.2.3/dist/cli.js",
      workingDirectory: "/srv/My App",
      homeDirectory: "/home/alice",
      environmentFile:
        "/home/alice/.config/ai-task-board/antigravity-bridge.env",
    });
    expect(unit).toContain("Description=AI Task Board Antigravity Bridge");
    expect(unit).toContain("WorkingDirectory=/srv/My App");
    expect(unit).toContain(
      "EnvironmentFile=/home/alice/.config/ai-task-board/antigravity-bridge.env",
    );
    expect(unit).toContain("run");
  });
});

describe("Antigravity Bridge 工作目录管理模式", () => {
  function buildEnvironment(
    overrides: Partial<
      Parameters<typeof buildAntigravityInstallEnvironment>[0]
    > = {},
  ) {
    return buildAntigravityInstallEnvironment({
      existing: {},
      boardUrl: "https://board.example.com",
      connectionToken: "atb_token",
      directoryManagement: "local",
      workingDirectory: "/srv/app",
      preserveMultipleDirectories: false,
      rawMultipleDirectories: undefined,
      agentMode: "auto",
      approvalMode: "decline",
      sandbox: false,
      maxThreads: "50",
      maxConcurrentTurns: "5",
      webConfiguration: false,
      agyBinary: "/usr/bin/agy",
      pathValue: "/usr/bin:/bin",
      ...overrides,
    });
  }

  it("Web 管理模式写入两个开关并移除本机目录变量", () => {
    const environment = buildEnvironment({
      existing: {
        ANTIGRAVITY_WORKING_DIRECTORY: "/srv/legacy",
        ANTIGRAVITY_WORKING_DIRECTORIES: '[{"key":"old","path":"/srv/old"}]',
        CUSTOM_RETAINED: "keep",
      },
      directoryManagement: "web",
      workingDirectory: "/home/alice",
      webConfiguration: true,
    });

    expect(environment.ANTIGRAVITY_BRIDGE_WEB_CONFIG).toBe("true");
    expect(
      environment.ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION,
    ).toBe("true");
    expect(environment).not.toHaveProperty("ANTIGRAVITY_WORKING_DIRECTORY");
    expect(environment).not.toHaveProperty("ANTIGRAVITY_WORKING_DIRECTORIES");
    expect(environment.CUSTOM_RETAINED).toBe("keep");
  });

  it("本机固定目录模式保持现状：写工作目录、不写远程目录授权开关", () => {
    const environment = buildEnvironment({
      directoryManagement: "local",
      workingDirectory: "/srv/app",
    });

    expect(environment.ANTIGRAVITY_WORKING_DIRECTORY).toBe("/srv/app");
    expect(environment).not.toHaveProperty("ANTIGRAVITY_WORKING_DIRECTORIES");
    expect(environment).not.toHaveProperty(
      "ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION",
    );
    expect(environment.ANTIGRAVITY_BRIDGE_WEB_CONFIG).toBe("false");
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

    expect(environment.ANTIGRAVITY_WORKING_DIRECTORY).toBe("/srv/main");
    expect(environment.ANTIGRAVITY_WORKING_DIRECTORIES).toBe(rawDirectories);
  });

  it("重跑安装保留已开启的远程目录授权", () => {
    const environment = buildEnvironment({
      existing: {
        ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
      },
      directoryManagement: "local",
      workingDirectory: "/srv/app",
    });

    expect(
      environment.ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION,
    ).toBe("true");
    expect(environment.ANTIGRAVITY_WORKING_DIRECTORY).toBe("/srv/app");
  });

  it("非交互安装未提供目录变量时默认 Web 管理，unit 以用户主目录兜底", () => {
    const resolution = resolveAntigravityDirectoryManagement({
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
      runtimeCli:
        "/home/alice/.local/share/ai-task-board/antigravity-bridge/versions/1.2.3/dist/cli.js",
      workingDirectory: resolution.workingDirectory,
      homeDirectory: "/home/alice",
      environmentFile:
        "/home/alice/.config/ai-task-board/antigravity-bridge.env",
    });
    expect(unit).toContain("WorkingDirectory=/home/alice");
  });

  it("非交互安装提供目录变量时按本机固定目录安装", () => {
    expect(
      resolveAntigravityDirectoryManagement({
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
      resolveAntigravityDirectoryManagement({
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
      resolveAntigravityDirectoryManagement({
        homeDirectory: "/home/alice",
        configuredDirectory: undefined,
        rawMultipleDirectories: "not-json",
      }),
    ).toThrow("ANTIGRAVITY_WORKING_DIRECTORIES 无法解析");
  });
});

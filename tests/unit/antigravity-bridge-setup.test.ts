import { describe, expect, it } from "vitest";

import {
  parseEnvironmentFile,
  renderSystemdUserUnit,
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

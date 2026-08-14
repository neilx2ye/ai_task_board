import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  KIMI_BRIDGE_SYSTEMD_SERVICE,
  parseEnvironmentFile,
  renderSystemdUserUnit,
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
    expect(unit).toContain("WorkingDirectory=/srv/My\\x20App");
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/alice/.local/share/bridge/dist/cli.js" "run"',
    );
    expect(unit).not.toContain("npx");
    expect(path.isAbsolute("/usr/bin/node")).toBe(true);
  });
});

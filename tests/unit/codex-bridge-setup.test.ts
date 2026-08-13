import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BRIDGE_SYSTEMD_SERVICE,
  discoverCodexProviderEnvironmentVariables,
  LEGACY_BRIDGE_SYSTEMD_SERVICE,
  parseEnvironmentFile,
  renderSystemdUserUnit,
  resolveExecutable,
  resolveSetupPaths,
  serializeEnvironmentFile,
} from "@/packages/codex-bridge/src/setup";

describe("Codex Bridge interactive setup", () => {
  it("uses the short service name and retains only the old name for migration", () => {
    expect(BRIDGE_SYSTEMD_SERVICE).toBe("ai-task-board-bridge.service");
    expect(LEGACY_BRIDGE_SYSTEMD_SERVICE).toBe(
      "ai-task-board-codex-bridge.service",
    );
  });

  it("places configuration, unit, and runtime under the effective user's homes", () => {
    expect(resolveSetupPaths("/home/alice", "0.9.0", {})).toEqual({
      configDirectory: "/home/alice/.config/ai-task-board",
      environmentFile:
        "/home/alice/.config/ai-task-board/codex-bridge.env",
      unitFile:
        "/home/alice/.config/systemd/user/ai-task-board-bridge.service",
      runtimeDirectory:
        "/home/alice/.local/share/ai-task-board/codex-bridge/versions/0.9.0",
      runtimeCli:
        "/home/alice/.local/share/ai-task-board/codex-bridge/versions/0.9.0/dist/cli.js",
    });

    const xdgPaths = resolveSetupPaths("/home/alice", "0.9.0", {
      XDG_CONFIG_HOME: "/srv/alice-config",
      XDG_DATA_HOME: "/srv/alice-data",
    });
    expect(xdgPaths.environmentFile).toBe(
      "/srv/alice-config/ai-task-board/codex-bridge.env",
    );
    expect(xdgPaths.unitFile).toBe(
      "/srv/alice-config/systemd/user/ai-task-board-bridge.service",
    );
    expect(xdgPaths.runtimeCli).toBe(
      "/srv/alice-data/ai-task-board/codex-bridge/versions/0.9.0/dist/cli.js",
    );
  });

  it("round-trips protected EnvironmentFile values without shell expansion", () => {
    const values = {
      AI_TASK_BOARD_URL: "https://board.example.com/team space",
      AI_TASK_BOARD_CONNECTION_TOKEN: 'atb_$secret#with"quotes\\slashes',
      CODEX_HOME: "/home/alice/.codex",
    };
    const serialized = serializeEnvironmentFile(values);

    expect(serialized).toContain(
      'AI_TASK_BOARD_CONNECTION_TOKEN="atb_$secret#with\\"quotes\\\\slashes"',
    );
    expect(parseEnvironmentFile(serialized)).toEqual(values);
    expect(() => serializeEnvironmentFile({ TOKEN: "line1\nline2" })).toThrow(
      "不能包含换行符",
    );
  });

  it("detects environment-backed custom provider credentials without reading values", () => {
    expect(
      discoverCodexProviderEnvironmentVariables(`
model_provider = "deepseek"

[model_providers.deepseek]
env_key = "DEEPSEEK_API_KEY"
env_key_instructions = "Set IGNORED_INSTRUCTIONS"
env_http_headers = { "X-Tenant" = "DEEPSEEK_TENANT" }

[model_providers.custom.env_http_headers]
"X-Organization" = "CUSTOM_ORG_ID"

# env_key = "COMMENTED_OUT_KEY"
`),
    ).toEqual([
      "CUSTOM_ORG_ID",
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_TENANT",
    ]);
  });

  it("renders a systemd user unit bound to HOME and CODEX_HOME without User=", () => {
    const unit = renderSystemdUserUnit({
      nodeBinary: "/opt/node versions/current/bin/node",
      runtimeCli: "/home/alice/data%20/bridge/dist/cli.js",
      workingDirectory: "/srv/my project",
      homeDirectory: "/home/alice",
      codexHome: "/home/alice/.codex-deepseek",
      environmentFile: "/home/alice/.config/ai task board/bridge.env",
    });

    expect(unit).not.toMatch(/^User=/m);
    expect(unit).toContain('Environment="HOME=/home/alice"');
    expect(unit).toContain(
      'Environment="CODEX_HOME=/home/alice/.codex-deepseek"',
    );
    expect(unit).toContain("WorkingDirectory=/srv/my\\x20project");
    expect(unit).toContain(
      'ExecStart="/opt/node versions/current/bin/node" "/home/alice/data%%20/bridge/dist/cli.js" "run"',
    );
    expect(unit).not.toContain("npx");
  });

  it("renders syntax accepted by systemd-analyze when it is available", async () => {
    if (spawnSync("systemd-analyze", ["--version"]).status !== 0) return;

    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "codex bridge unit-"),
    );
    try {
      const environmentFile = path.join(temporaryDirectory, "bridge.env");
      const unitFile = path.join(
        temporaryDirectory,
        "ai-task-board-bridge.service",
      );
      await writeFile(environmentFile, 'AI_TASK_BOARD_URL="https://example.com"\n');
      await writeFile(
        unitFile,
        renderSystemdUserUnit({
          nodeBinary: "/bin/true",
          runtimeCli: path.join(temporaryDirectory, "bridge cli.js"),
          workingDirectory: temporaryDirectory,
          homeDirectory: temporaryDirectory,
          codexHome: path.join(temporaryDirectory, ".codex"),
          environmentFile,
        }),
      );

      const result = spawnSync(
        "systemd-analyze",
        ["--user", "verify", unitFile],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("resolves the Codex executable from the captured user PATH", async () => {
    const executable = await resolveExecutable("sh", {
      cwd: "/tmp",
      homeDirectory: "/home/alice",
      pathValue: "/definitely-missing:/bin:/usr/bin",
    });

    expect(executable).toBe(path.resolve("/bin/sh"));
    expect(
      await resolveExecutable("missing-codex-binary", {
        cwd: "/tmp",
        homeDirectory: "/home/alice",
        pathValue: "/bin:/usr/bin",
      }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  BRIDGE_CONCURRENCY_NOTICE,
  BRIDGE_HISTORY_RETENTION_NOTICE,
  isAbsoluteWorkingDirectoryPath,
  nextDirectoryKey,
  permissionLabel,
  validateWorkingDirectories,
} from "@/components/bridge-config-dialog";
import {
  bridgeConfigMutationFingerprint,
  bridgeConfigSyncState,
  bridgeSupportsHistorySync,
  bridgeSupportsRemoteConfiguration,
  bridgeSupportsWorkingDirectoryConfiguration,
  supportsHistorySyncStatus,
  supportsBridgeSettings,
  type BridgeConfiguration,
} from "@/hooks/use-bridge-config";

function configuration(
  overrides: Partial<BridgeConfiguration> = {},
): BridgeConfiguration {
  return {
    connection_id: "conn-1",
    version: 3,
    desired: {
      enabled: true,
      include_thread_titles: false,
      max_threads: 50,
      max_concurrent_turns: 2,
      sync_history: false,
      history_turn_limit: 50,
      working_directories: null,
      permission_mode: "danger-full-access",
      approval_mode: "accept",
    },
    applied: {
      version: 3,
      effective: {
        enabled: true,
        include_thread_titles: false,
        max_threads: 50,
        max_concurrent_turns: 2,
        sync_history: false,
        history_turn_limit: 50,
        permission_mode: "danger-full-access",
        approval_mode: "accept",
        working_directories: [
          {
            directory_key: "default",
            name: "project",
            working_directory: "/srv/project",
          },
        ],
      },
      constraints: {
        remote_configuration_enabled: true,
        allow_thread_titles: false,
        max_threads: 50,
        max_concurrent_turns: 2,
        allow_history_sync: false,
        max_history_turns: 50,
        allow_working_directory_configuration: false,
        thread_scope: "cwd",
        working_directory: "/srv/project",
        fixed_thread: false,
        permission_mode: "safe",
        approval_mode: "decline",
      },
      error: null,
      applied_at: "2026-08-10T00:00:00.000Z",
    },
    runtime: {
      online: true,
      lease_expires_at: "2099-08-10T00:00:00.000Z",
    },
    updated_at: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("Bridge configuration UI model", () => {
  it("labels every device permission profile explicitly", () => {
    expect(permissionLabel("danger-full-access")).toBe("完全访问（无沙箱）");
    expect(permissionLabel("safe")).toBe("安全模式");
    expect(permissionLabel("inherit")).toBe("继承本机设置");
  });

  it("presents device concurrency as one Web-controlled limit", () => {
    expect(BRIDGE_CONCURRENCY_NOTICE).toContain("Web 设置的 1 到 32");
    expect(BRIDGE_CONCURRENCY_NOTICE).toContain("整台设备");
    expect(BRIDGE_CONCURRENCY_NOTICE).not.toContain("本机上限");
  });

  it("explains that narrower future imports do not delete uploaded history", () => {
    expect(BRIDGE_HISTORY_RETENTION_NOTICE).toContain("停止或收窄后续导入");
    expect(BRIDGE_HISTORY_RETENTION_NOTICE).toContain("不会删除已经上传的历史");
  });

  it("exposes settings for every Bridge platform", () => {
    expect(
      supportsBridgeSettings({ bridge_version: "0.3.0", platform: "自定义 Agent" }),
    ).toBe(true);
    expect(
      supportsBridgeSettings({ bridge_version: null, platform: "Codex CLI" }),
    ).toBe(true);
    expect(
      supportsBridgeSettings({ bridge_version: null, platform: "CODEX" }),
    ).toBe(true);
    expect(
      supportsBridgeSettings({ bridge_version: null, platform: "Claude" }),
    ).toBe(true);
    expect(
      supportsBridgeSettings({ bridge_version: null, platform: "Kimi Code" }),
    ).toBe(true);
    expect(
      supportsBridgeSettings({
        bridge_version: null,
        platform: "Antigravity",
      }),
    ).toBe(true);
  });

  it("limits the Codex history banner to non-Kimi/Antigravity/Claude Bridges", () => {
    expect(
      supportsHistorySyncStatus({ bridge_version: "1.1.0", platform: "Codex CLI" }),
    ).toBe(true);
    expect(
      supportsHistorySyncStatus({
        bridge_version: "1.1.0-kimi.1",
        platform: "Kimi Code",
      }),
    ).toBe(false);
    expect(
      supportsHistorySyncStatus({
        bridge_version: "1.1.0-antigravity.1",
        platform: "Antigravity",
      }),
    ).toBe(false);
    expect(
      supportsHistorySyncStatus({
        bridge_version: "1.1.0-claude.1",
        platform: "Claude Code",
      }),
    ).toBe(false);
  });

  it("never claims an old or unreported Bridge applied the desired config", () => {
    expect(bridgeConfigSyncState(configuration(), null)).toBe("upgrade-required");
    expect(bridgeConfigSyncState(configuration(), "0.2.0")).toBe(
      "upgrade-required",
    );
    expect(bridgeSupportsRemoteConfiguration("0.3.0")).toBe(true);
    expect(bridgeSupportsRemoteConfiguration("1.0.0")).toBe(true);
    expect(bridgeSupportsHistorySync("0.3.9")).toBe(false);
    expect(bridgeSupportsHistorySync("0.4.0")).toBe(true);
    expect(bridgeSupportsHistorySync("1.0.0")).toBe(true);
    expect(bridgeSupportsWorkingDirectoryConfiguration("0.7.9")).toBe(false);
    expect(bridgeSupportsWorkingDirectoryConfiguration("0.8.0")).toBe(true);
    expect(bridgeSupportsWorkingDirectoryConfiguration("1.0.0")).toBe(true);
  });

  it("distinguishes pending, local blocking, errors, and local caps", () => {
    expect(
      bridgeConfigSyncState(configuration({ applied: null }), "0.3.0"),
    ).toBe("waiting");

    const firstHandshake = configuration();
    firstHandshake.applied!.version = null;
    firstHandshake.applied!.effective = null;
    expect(bridgeConfigSyncState(firstHandshake, "0.3.0")).toBe("waiting");

    const blocked = configuration();
    blocked.applied!.constraints.remote_configuration_enabled = false;
    expect(bridgeConfigSyncState(blocked, "0.3.0")).toBe("remote-disabled");

    const failed = configuration();
    failed.applied!.error = "invalid local configuration";
    expect(bridgeConfigSyncState(failed, "0.3.0")).toBe("error");

    const capped = configuration();
    capped.applied!.effective!.max_threads = 20;
    capped.applied!.error = "max_threads 已限制为 20";
    expect(bridgeConfigSyncState(capped, "0.3.0")).toBe("constrained");

    expect(bridgeConfigSyncState(configuration(), "0.3.0")).toBe("applied");
  });

  it("does not present a stale applied report as currently active", () => {
    const offline = configuration({
      runtime: {
        online: false,
        lease_expires_at: "2026-08-10T00:00:00.000Z",
      },
    });
    expect(bridgeConfigSyncState(offline, "0.3.0")).toBe("offline");
  });

  it("uses a stable fingerprint for retries and rotates it with the version", () => {
    const input = {
      expected_version: 3,
      enabled: true,
      include_thread_titles: true,
      max_threads: 40,
      max_concurrent_turns: 4,
      sync_history: true,
      history_turn_limit: 50,
      working_directories: null,
      permission_mode: "danger-full-access" as const,
      approval_mode: "accept" as const,
    };
    const first = bridgeConfigMutationFingerprint("conn-1", "codex", input);
    expect(
      bridgeConfigMutationFingerprint("conn-1", "codex", { ...input }),
    ).toBe(first);
    expect(
      bridgeConfigMutationFingerprint("conn-1", "kimi", input),
    ).not.toBe(first);
    expect(
      bridgeConfigMutationFingerprint("conn-1", "codex", {
        ...input,
        expected_version: 4,
      }),
    ).not.toBe(first);
    expect(
      bridgeConfigMutationFingerprint("conn-1", "codex", {
        ...input,
        history_turn_limit: 40,
      }),
    ).not.toBe(first);
    expect(
      bridgeConfigMutationFingerprint("conn-1", "codex", {
        ...input,
        working_directories: [
          {
            directory_key: "docs",
            name: "Docs",
            working_directory: "/srv/docs",
          },
        ],
      }),
    ).not.toBe(first);
  });

  it("validates Web-managed project paths before submitting", () => {
    expect(isAbsoluteWorkingDirectoryPath("/srv/project")).toBe(true);
    expect(isAbsoluteWorkingDirectoryPath("C:\\work\\project")).toBe(true);
    expect(isAbsoluteWorkingDirectoryPath("relative/project")).toBe(false);

    expect(validateWorkingDirectories([])).toBeNull();
    const valid = [
      {
        directory_key: "main",
        name: "Main app",
        working_directory: "/srv/main",
      },
      {
        directory_key: "docs",
        name: "Docs",
        working_directory: "/srv/docs",
      },
    ];
    expect(validateWorkingDirectories(valid)).toBeNull();
    expect(
      validateWorkingDirectories([
        ...valid,
        {
          directory_key: "docs",
          name: "Duplicate",
          working_directory: "/srv/duplicate",
        },
      ]),
    ).toContain("标识不能重复");
    expect(
      validateWorkingDirectories([
        {
          directory_key: "relative",
          name: "Relative",
          working_directory: "work/project",
        },
      ]),
    ).toContain("绝对工作路径");
  });

  it("auto-assigns directory keys without reusing known keys", () => {
    expect(nextDirectoryKey([])).toBe("project");
    expect(nextDirectoryKey(["project"])).toBe("project-2");
    expect(
      nextDirectoryKey(["project", "project-2", "project-3"]),
    ).toBe("project-4");
    expect(nextDirectoryKey(["docs", "main"])).toBe("project");
  });

  it("keeps auto-assigned keys stable for the same known set", () => {
    const taken = ["project", "project-2"];
    expect(nextDirectoryKey(taken)).toBe(nextDirectoryKey(taken));
    expect(
      validateWorkingDirectories([
        {
          directory_key: nextDirectoryKey(taken),
          name: "Auto project",
          working_directory: "/srv/auto",
        },
      ]),
    ).toBeNull();
  });
});

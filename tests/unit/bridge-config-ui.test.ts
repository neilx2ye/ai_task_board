import { describe, expect, it } from "vitest";

import { BRIDGE_HISTORY_RETENTION_NOTICE } from "@/components/bridge-config-dialog";
import {
  bridgeConfigMutationFingerprint,
  bridgeConfigSyncState,
  bridgeSupportsHistorySync,
  bridgeSupportsRemoteConfiguration,
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
      },
      constraints: {
        remote_configuration_enabled: true,
        allow_thread_titles: false,
        max_threads: 50,
        max_concurrent_turns: 2,
        allow_history_sync: false,
        max_history_turns: 50,
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
  it("explains that narrower future imports do not delete uploaded history", () => {
    expect(BRIDGE_HISTORY_RETENTION_NOTICE).toContain("停止或收窄后续导入");
    expect(BRIDGE_HISTORY_RETENTION_NOTICE).toContain("不会删除已经上传的历史");
  });

  it("only exposes settings for a reported Bridge or a Codex connection", () => {
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
    };
    const first = bridgeConfigMutationFingerprint("conn-1", input);
    expect(bridgeConfigMutationFingerprint("conn-1", { ...input })).toBe(first);
    expect(
      bridgeConfigMutationFingerprint("conn-1", {
        ...input,
        expected_version: 4,
      }),
    ).not.toBe(first);
    expect(
      bridgeConfigMutationFingerprint("conn-1", {
        ...input,
        history_turn_limit: 40,
      }),
    ).not.toBe(first);
  });
});

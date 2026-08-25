import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deviceIdentityFile as codexDeviceIdentityFile,
  loadDeviceIdentity as loadCodexDeviceIdentity,
} from "../../packages/codex-bridge/src/device-identity";
import { loadDeviceIdentity as loadKimiDeviceIdentity } from "../../packages/kimi-bridge/src/device-identity";
import { loadDeviceIdentity as loadAntigravityDeviceIdentity } from "../../packages/antigravity-bridge/src/device-identity";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("Bridge device identity", () => {
  let temporaryDirectory: string | null = null;

  function configHome(): string {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), "atb-device-id-"));
    return temporaryDirectory;
  }

  afterEach(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  it("generates a UUID on first use and persists it with 0600 permissions", () => {
    const environment = { XDG_CONFIG_HOME: configHome() };
    const identity = loadCodexDeviceIdentity(environment);
    expect(identity.deviceId).toMatch(UUID_PATTERN);
    expect(identity.deviceLabel).toBe(os.hostname());

    const file = codexDeviceIdentityFile(environment);
    expect(file).toBe(
      path.join(temporaryDirectory!, "ai-task-board", "device-id"),
    );
    expect(readFileSync(file, "utf8").trim()).toBe(identity.deviceId);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reuses the persisted ID and shares it across all three runtimes", () => {
    const environment = { XDG_CONFIG_HOME: configHome() };
    const codex = loadCodexDeviceIdentity(environment);
    const kimi = loadKimiDeviceIdentity(environment);
    const antigravity = loadAntigravityDeviceIdentity(environment);
    expect(kimi.deviceId).toBe(codex.deviceId);
    expect(antigravity.deviceId).toBe(codex.deviceId);
    expect(loadCodexDeviceIdentity(environment).deviceId).toBe(codex.deviceId);
  });

  it("replaces a corrupt file with a fresh persisted ID", () => {
    const environment = { XDG_CONFIG_HOME: configHome() };
    const file = codexDeviceIdentityFile(environment);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not-a-uuid\n", "utf8");
    const identity = loadCodexDeviceIdentity(environment);
    expect(identity.deviceId).toMatch(UUID_PATTERN);
    expect(readFileSync(file, "utf8").trim()).toBe(identity.deviceId);
    expect(loadCodexDeviceIdentity(environment).deviceId).toBe(
      identity.deviceId,
    );
  });
});

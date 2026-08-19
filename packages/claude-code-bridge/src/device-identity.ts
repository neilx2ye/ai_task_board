import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeviceIdentity = {
  deviceId: string;
  deviceLabel: string;
};

/**
 * All AI Task Board bridges on one device share the same configuration
 * directory, so a single device-id file groups every runtime of the host.
 */
export function deviceIdentityFile(
  environment: Record<string, string | undefined> = process.env,
): string {
  const configHome =
    environment.XDG_CONFIG_HOME && path.isAbsolute(environment.XDG_CONFIG_HOME)
      ? path.normalize(environment.XDG_CONFIG_HOME)
      : path.join(os.homedir(), ".config");
  return path.join(configHome, "ai-task-board", "device-id");
}

/**
 * Return the stable device identity, generating and persisting a UUID on
 * first use. Persistence failures degrade to an ephemeral ID with a stderr
 * warning instead of failing Bridge startup.
 */
export function loadDeviceIdentity(
  environment: Record<string, string | undefined> = process.env,
): DeviceIdentity {
  const deviceLabel = os.hostname();
  const file = deviceIdentityFile(environment);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (DEVICE_ID_PATTERN.test(existing)) {
      return { deviceId: existing, deviceLabel };
    }
  } catch {
    // Missing or unreadable file: regenerate below.
  }

  const deviceId = randomUUID();
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, `${deviceId}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      chmodSync(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A concurrently started Bridge won the creation race; reuse its ID.
      const winner = readFileSync(file, "utf8").trim();
      if (DEVICE_ID_PATTERN.test(winner)) {
        return { deviceId: winner, deviceLabel };
      }
      // A corrupt leftover file is replaced atomically so the ID heals.
      const temporary = `${file}.tmp-${process.pid}`;
      writeFileSync(temporary, `${deviceId}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, file);
      chmodSync(file, 0o600);
    }
  } catch (error) {
    process.stderr.write(
      `无法持久化设备标识（${file}），本次运行使用临时设备 ID：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  return { deviceId, deviceLabel };
}

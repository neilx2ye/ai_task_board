import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyDefaultBoardUrl,
  DEFAULT_BOARD_URL,
  hasConnectionEnvironment,
  normalizeBoardUrl,
} from "@/packages/codex-bridge/src/interactive";
import {
  parseBridgeRunTarget,
  parseBridgeSetupTarget,
} from "@/packages/codex-bridge/src/installer";

describe("Unified Bridge CLI interaction", () => {
  it("defaults the Board address only when it is missing", () => {
    const environment: Record<string, string | undefined> = {};
    applyDefaultBoardUrl(environment);
    expect(environment.AI_TASK_BOARD_URL).toBe(DEFAULT_BOARD_URL);

    const customized: Record<string, string | undefined> = {
      AI_TASK_BOARD_URL: "https://board.example.com/",
    };
    applyDefaultBoardUrl(customized);
    expect(customized.AI_TASK_BOARD_URL).toBe("https://board.example.com/");
  });

  it("treats the Connection Token as the only required connection input", () => {
    expect(hasConnectionEnvironment({})).toBe(false);
    expect(hasConnectionEnvironment({ AI_TASK_BOARD_URL: "https://x.dev" })).toBe(
      false,
    );
    expect(
      hasConnectionEnvironment({ AI_TASK_BOARD_CONNECTION_TOKEN: "atb_token" }),
    ).toBe(true);
  });

  it("normalizes Board URLs without rejecting the default", () => {
    expect(normalizeBoardUrl(DEFAULT_BOARD_URL)).toBe(DEFAULT_BOARD_URL);
    expect(normalizeBoardUrl("  https://board.example.com/// ")).toBe(
      "https://board.example.com",
    );
    expect(() => normalizeBoardUrl("ftp://board.example.com")).toThrow(
      "只支持 http:// 或 https://",
    );
  });

  it("parses explicit and aliased Bridge targets", () => {
    expect(parseBridgeSetupTarget("kimi-code")).toBe("kimi");
    expect(parseBridgeSetupTarget("agy")).toBe("antigravity");
    expect(parseBridgeSetupTarget("both")).toBe("both");
    expect(parseBridgeRunTarget("both")).toBeNull();
    expect(parseBridgeRunTarget("antigravity")).toBe("antigravity");
  });

  it("keeps setup out of non-TTY runs when no token is configured", () => {
    const isolatedHome = mkdtempSync(path.join(tmpdir(), "atb-cli-test-"));
    const environment = { ...process.env };
    delete environment.AI_TASK_BOARD_URL;
    delete environment.AI_TASK_BOARD_CONNECTION_TOKEN;
    environment.HOME = isolatedHome;
    environment.XDG_CONFIG_HOME = path.join(isolatedHome, ".config");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/codex-bridge/src/cli.ts",
        "setup",
      ],
      {
        cwd: path.resolve(process.cwd()),
        encoding: "utf8",
        env: environment,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AI_TASK_BOARD_CONNECTION_TOKEN");
    expect(result.stderr).toContain("交互式终端");
    rmSync(isolatedHome, { recursive: true, force: true });
  });
});

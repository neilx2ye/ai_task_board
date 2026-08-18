import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  boundActivityData,
  redactHarnessText,
  sanitizeHarnessValue,
} from "@/lib/bridge/activity-sanitizer";
import {
  isSessionActiveClaimConflict,
  nextClaimAction,
} from "@/lib/bridge/claim-retry";

describe("Harness activity sanitization", () => {
  it("loads the repository bridge entrypoint without an ESM import failure", () => {
    const environment = { ...process.env };
    delete environment.AI_TASK_BOARD_URL;
    delete environment.AI_TASK_BOARD_CONNECTION_TOKEN;
    delete environment.CODEX_THREAD_ID;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/codex-bridge.ts"],
      {
        cwd: path.resolve(process.cwd()),
        encoding: "utf8",
        env: environment,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AI_TASK_BOARD_CONNECTION_TOKEN");
    expect(result.stderr).not.toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  it("exposes npx-friendly help without requiring Bridge configuration", () => {
    const environment = { ...process.env };
    delete environment.AI_TASK_BOARD_URL;
    delete environment.AI_TASK_BOARD_CONNECTION_TOKEN;
    delete environment.CODEX_THREAD_ID;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/codex-bridge/src/cli.ts",
        "--help",
      ],
      {
        cwd: path.resolve(process.cwd()),
        encoding: "utf8",
        env: environment,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ai-task-board-bridge");
    expect(result.stdout).toContain("ai-task-board-bridge setup");
    expect(result.stdout).toContain("current user's systemd service");
    expect(result.stdout).toContain("AI_TASK_BOARD_CONNECTION_TOKEN");
    expect(result.stdout).toContain("accept (default), decline, or accept-session");
    expect(result.stdout).toContain(
      "danger-full-access (default), safe, or inherit",
    );
    expect(result.stderr).toBe("");
  });

  it("requires a terminal for the interactive setup command", () => {
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
        env: process.env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("setup 需要交互式终端");
  });

  it("redacts common token shapes without corrupting ordinary text", () => {
    expect(redactHarnessText("ordinary command output")).toBe(
      "ordinary command output",
    );
    expect(
      redactHarnessText(
        "sk_abcdefghijklmnop sk-proj-abcdefghijklmnop atb_abcdefghijklmnop Authorization: Bearer 'hidden bearer' api_key=also-hidden password='quoted secret' \"private_key\": \"json secret\"",
      ),
    ).toBe(
      "[REDACTED] [REDACTED] [REDACTED] Authorization: Bearer [REDACTED] api_key=[REDACTED] password=[REDACTED] \"private_key\": [REDACTED]",
    );
    expect(redactHarnessText("x".repeat(100), 40)).toHaveLength(40);
  });

  it("limits collection width and nesting depth", () => {
    const sanitized = sanitizeHarnessValue({
      values: Array.from({ length: 150 }, (_, index) => index),
      deep: { one: { two: { three: { four: { five: { six: { seven: "secret" } } } } } } },
    }) as { values: number[]; deep: unknown };

    expect(sanitized.values).toHaveLength(100);
    expect(JSON.stringify(sanitized.deep)).toContain("嵌套过深");
  });

  it("uses structured field names to redact otherwise unrecognizable secrets", () => {
    expect(
      sanitizeHarnessValue({
        arguments: {
          api_key: "plain-value",
          password: "another-plain-value",
          bearerToken: "third-plain-value",
          input_tokens: 123,
        },
      }),
    ).toEqual({
      arguments: {
        api_key: "[REDACTED]",
        password: "[REDACTED]",
        bearerToken: "[REDACTED]",
        input_tokens: 123,
      },
    });
  });

  it("bounds multibyte structured output below the API ceiling", () => {
    const bounded = boundActivityData(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          `output_${index}`,
          "界".repeat(20_000),
        ]),
      ),
    );
    const byteLength = new TextEncoder().encode(JSON.stringify(bounded)).byteLength;

    expect(bounded).toMatchObject({ truncated: true });
    expect(byteLength).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("Codex Bridge claim recovery", () => {
  it("retries only the exact active-claim conflict", () => {
    expect(
      isSessionActiveClaimConflict({
        code: "INVALID_STATE_TRANSITION",
        message: "The AI session already has an active task",
        status: 409,
      }),
    ).toBe(true);
    expect(
      isSessionActiveClaimConflict({
        code: "INVALID_STATE_TRANSITION",
        message: "A different state transition failed",
        status: 409,
      }),
    ).toBe(false);
    expect(
      isSessionActiveClaimConflict({
        code: "TASK_ALREADY_CLAIMED",
        message: "The AI session already has an active task",
        status: 409,
      }),
    ).toBe(false);
  });

  it("lets a stop request win over an in-flight successful claim", () => {
    expect(nextClaimAction({ hasTask: true, stopping: true })).toBe("stop");
    expect(nextClaimAction({ hasTask: false, stopping: true })).toBe("stop");
    expect(nextClaimAction({ hasTask: true, stopping: false })).toBe("execute");
    expect(nextClaimAction({ hasTask: false, stopping: false })).toBe("idle");
  });
});

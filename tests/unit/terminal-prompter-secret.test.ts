import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptAvailable =
  process.platform === "linux" &&
  spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

function waitForOutput(
  output: () => string,
  needle: string,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (output().includes(needle)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `Timed out waiting for ${JSON.stringify(needle)}\n---\n${output()}`,
          ),
        );
      }
    }, 25);
  });
}

/**
 * Runs TerminalPrompter on a real pseudo-terminal: readline previously
 * erased a directly written secret-prompt label and Node 22 made its echo
 * hook a Symbol, so this guards both the visible prompt and the muted
 * typed characters plus the readline recreation used for later questions.
 */
describe.skipIf(!scriptAvailable)("TerminalPrompter secret prompt on a PTY", () => {
  it("shows the prompt without echoing the secret and keeps asking", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "atb-secret-pty-"));
    const probe = path.join(directory, "probe.mjs");
    const resultFile = path.join(directory, "result.json");
    const interactiveSource = path.resolve(
      "packages/codex-bridge/src/interactive.ts",
    );
    writeFileSync(
      probe,
      [
        'import { writeFileSync } from "node:fs";',
        `import { TerminalPrompter } from ${JSON.stringify(interactiveSource)};`,
        "const prompt = new TerminalPrompter(process.stdin, process.stdout);",
        'const secret = await prompt.secret("Token", "saved");',
        'const text = await prompt.text("Next");',
        `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ secret, text }));`,
        "prompt.close();",
      ].join("\n"),
      "utf8",
    );

    const child = spawn(
      "script",
      ["-qec", `node --import tsx ${JSON.stringify(probe)}`, "/dev/null"],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });

    try {
      await waitForOutput(() => output, "Token（回车保留现有值）: ");
      child.stdin.write("my-secret-value\r");
      await waitForOutput(() => output, "Next: ");
      child.stdin.write("next-value\r");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });

      const result = JSON.parse(readFileSync(resultFile, "utf8")) as {
        secret: string;
        text: string;
      };
      expect(result).toEqual({ secret: "my-secret-value", text: "next-value" });
      expect(output).toContain("Token（回车保留现有值）: ");
      expect(output).not.toContain("my-secret-value");
      expect(output).toContain("Next: ");
    } finally {
      child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});

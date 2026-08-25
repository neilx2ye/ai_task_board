import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRemoteWorkingDirectories } from "../../packages/codex-bridge/src/working-directories";

describe("Codex parseRemoteWorkingDirectories create_if_missing", () => {
  let temporaryDirectory: string | null = null;

  function baseDirectory(): string {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), "atb-codex-dirs-"));
    return temporaryDirectory;
  }

  afterEach(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  it("ships Bridge version 1.8.8", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.resolve("packages/codex-bridge/package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(manifest.version).toBe("1.8.8");
  });

  it("parses an existing directory without the flag", () => {
    const root = baseDirectory();
    const entries = parseRemoteWorkingDirectories([
      {
        directory_key: "app",
        name: "App",
        working_directory: root,
      },
    ]);
    expect(entries).toEqual([
      { key: "app", name: "App", workingDirectory: root },
    ]);
  });

  it("fails closed for a missing directory without create_if_missing", () => {
    const missing = path.join(baseDirectory(), "missing");
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "new",
          name: "New project",
          working_directory: missing,
        },
      ]),
    ).toThrow("不存在或不是目录");
    expect(existsSync(missing)).toBe(false);

    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "new",
          name: "New project",
          working_directory: missing,
          create_if_missing: false,
        },
      ]),
    ).toThrow("不存在或不是目录");
    expect(existsSync(missing)).toBe(false);
  });

  it("creates missing directories recursively when create_if_missing is true", () => {
    const nested = path.join(baseDirectory(), "level-1", "level-2", "project");
    const entries = parseRemoteWorkingDirectories([
      {
        directory_key: "project",
        name: "Project",
        working_directory: nested,
        create_if_missing: true,
      },
    ]);
    expect(entries).toEqual([
      { key: "project", name: "Project", workingDirectory: nested },
    ]);
    expect(existsSync(nested)).toBe(true);
  });

  it("keeps the uniform error when the path is an existing file", () => {
    const root = baseDirectory();
    const file = path.join(root, "not-a-directory");
    writeFileSync(file, "content", "utf8");
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "file",
          name: "File",
          working_directory: file,
          create_if_missing: true,
        },
      ]),
    ).toThrow("不存在或不是目录");
  });

  it("rejects a non-boolean create_if_missing and unknown fields", () => {
    const root = baseDirectory();
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "app",
          name: "App",
          working_directory: root,
          create_if_missing: "yes",
        },
      ]),
    ).toThrow("create_if_missing 必须是布尔值");
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "app",
          name: "App",
          working_directory: root,
          mkdir: true,
        },
      ]),
    ).toThrow("包含未知字段 mkdir");
  });

  it("still rejects relative paths even with create_if_missing", () => {
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "relative",
          name: "Relative",
          working_directory: "some/relative/path",
          create_if_missing: true,
        },
      ]),
    ).toThrow("必须是绝对路径");
  });

  it("rejects duplicate resolved paths after creation", () => {
    const root = baseDirectory();
    const created = path.join(root, "shared");
    mkdirSync(created);
    expect(() =>
      parseRemoteWorkingDirectories([
        {
          directory_key: "one",
          name: "One",
          working_directory: created,
        },
        {
          directory_key: "two",
          name: "Two",
          working_directory: path.join(root, ".", "shared"),
          create_if_missing: true,
        },
      ]),
    ).toThrow("重复路径");
  });
});

import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listDeviceDirectory,
  readDeviceFilePreview,
} from "../../packages/codex-bridge/src/device-file-access";

/** 1x1 透明 PNG。 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("Codex device file access", () => {
  let root = "";
  let outside = "";
  const directories = () => [{ workingDirectory: root }];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "atb-device-files-"));
    outside = await mkdtemp(path.join(tmpdir(), "atb-device-outside-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Hello\n\n正文。\n");
    await writeFile(path.join(root, "src", "util.ts"), "export const x = 1;\n");
    await writeFile(path.join(root, ".env.local"), "SECRET=1\n");
    await writeFile(path.join(root, "pixel.png"), TINY_PNG);
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
    await symlink("/etc", path.join(root, "escape-link"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("lists visible entries, directories first, skipping hidden/symlink/ignored", async () => {
    const listing = await listDeviceDirectory(directories(), root);
    const names = listing.entries.map((entry) => entry.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
    expect(names).toContain("pixel.png");
    expect(names).not.toContain(".env.local");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("escape-link");
    expect(names.indexOf("src")).toBeLessThan(names.indexOf("README.md"));
  });

  it("previews text and image files", async () => {
    const text = await readDeviceFilePreview(
      directories(),
      path.join(root, "README.md"),
    );
    expect(text.kind).toBe("text");
    if (text.kind === "text") expect(text.content).toContain("# Hello");

    const image = await readDeviceFilePreview(
      directories(),
      path.join(root, "pixel.png"),
    );
    expect(image.kind).toBe("image");
    if (image.kind === "image") {
      expect(image.dataUrl).toMatch(/^data:image\/png;base64,/);
    }
  });

  it("reports binary files and refuses sensitive names", async () => {
    const binary = await readDeviceFilePreview(
      directories(),
      path.join(root, "blob.bin"),
    );
    expect(binary.kind).toBe("binary");

    await expect(
      readDeviceFilePreview(directories(), path.join(root, ".env.local")),
    ).rejects.toThrow(/不允许预览/);
  });

  it("rejects paths outside the managed working directories", async () => {
    await expect(
      listDeviceDirectory(directories(), outside),
    ).rejects.toThrow(/白名单/);
    await expect(
      readDeviceFilePreview(directories(), "/etc/passwd"),
    ).rejects.toThrow(/白名单/);
  });
});

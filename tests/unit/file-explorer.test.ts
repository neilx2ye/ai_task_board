import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MAX_TEXT_PREVIEW_BYTES,
  listDirectoryContents,
  listProjectSuggestions,
  readFilePreview,
} from "@/lib/domain/file-explorer";
import {
  chunkLooksBinary,
  isMarkdownFile,
  isSensitiveFileName,
  isTextFile,
} from "@/lib/file-kinds";

/** 1x1 透明 PNG。 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let workspaceRoot = "";
let outsideRoot = "";
const originalRoots = process.env.FILE_EXPLORER_ROOTS;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "file-explorer-root-"));
  outsideRoot = await mkdtemp(path.join(os.tmpdir(), "file-explorer-out-"));
  process.env.FILE_EXPLORER_ROOTS = workspaceRoot;
  delete process.env.FILE_EXPLORER_IGNORED_DIRECTORIES;

  const project = path.join(workspaceRoot, "project");
  await mkdir(path.join(project, "src", "lib"), { recursive: true });
  await mkdir(path.join(project, "node_modules", "pkg"), { recursive: true });

  await writeFile(path.join(project, "README.md"), "# Hello\n\n正文 **加粗**。\n");
  await writeFile(path.join(project, "notes.txt"), "纯文本内容\n");
  await writeFile(path.join(project, "data.json"), '{"ok": true}\n');
  await writeFile(path.join(project, "src", "lib", "util.ts"), "export const x = 1;\n");
  await writeFile(path.join(project, ".env.local"), "SUPABASE_SECRET_KEY=secret\n");
  await writeFile(path.join(project, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  await writeFile(path.join(project, "pixel.png"), TINY_PNG);
  await writeFile(path.join(project, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
  await writeFile(path.join(project, "noext"), "没有扩展名的文本\n");
  await writeFile(path.join(project, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await symlink("/etc", path.join(project, "escape-link"));
  await writeFile(path.join(outsideRoot, "secret.txt"), "外部文件\n");
});

afterAll(async () => {
  if (originalRoots === undefined) delete process.env.FILE_EXPLORER_ROOTS;
  else process.env.FILE_EXPLORER_ROOTS = originalRoots;
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

describe("file kind helpers", () => {
  it("classifies markdown, text and sensitive names", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("notes.markdown")).toBe(true);
    expect(isMarkdownFile("app.ts")).toBe(false);
    expect(isTextFile("main.py")).toBe(true);
    expect(isTextFile("Makefile")).toBe(true);
    expect(isSensitiveFileName(".env.local")).toBe(true);
    expect(isSensitiveFileName("id_ed25519.pub")).toBe(true);
    expect(isSensitiveFileName("README.md")).toBe(false);
  });

  it("detects binary chunks by NUL bytes", () => {
    expect(chunkLooksBinary(new Uint8Array([65, 66, 67]))).toBe(false);
    expect(chunkLooksBinary(new Uint8Array([65, 0, 67]))).toBe(true);
  });
});

describe("directory listing", () => {
  it("lists visible entries, directories first, skipping hidden/symlink/ignored", async () => {
    const listing = await listDirectoryContents(
      path.join(workspaceRoot, "project"),
    );

    const names = listing.entries.map((entry) => entry.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
    expect(names).toContain("id_rsa");
    expect(names).not.toContain(".env.local");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("escape-link");

    const directoryIndex = names.indexOf("src");
    const fileIndex = names.indexOf("README.md");
    expect(directoryIndex).toBeLessThan(fileIndex);
    expect(listing.entries.find((entry) => entry.name === "README.md")?.size).toBeGreaterThan(0);
  });

  it("lists candidate projects under the allowed roots", async () => {
    const suggestions = await listProjectSuggestions();
    expect(suggestions.roots).toEqual([workspaceRoot]);
    expect(suggestions.projects.map((project) => project.name)).toContain(
      "project",
    );
  });

  it("rejects missing, relative and out-of-root paths", async () => {
    await expect(
      listDirectoryContents(path.join(workspaceRoot, "missing")),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
    await expect(listDirectoryContents("project")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(listDirectoryContents(outsideRoot)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("file preview", () => {
  it("returns markdown and plain text content", async () => {
    const markdown = await readFilePreview(
      path.join(workspaceRoot, "project", "README.md"),
    );
    expect(markdown).toMatchObject({ kind: "text", truncated: false });
    if (markdown.kind === "text") {
      expect(markdown.content).toContain("# Hello");
    }

    const unknown = await readFilePreview(
      path.join(workspaceRoot, "project", "noext"),
    );
    expect(unknown).toMatchObject({ kind: "text" });
    if (unknown.kind === "text") {
      expect(unknown.content).toContain("没有扩展名");
    }
  });

  it("serves small images as data URLs", async () => {
    const image = await readFilePreview(
      path.join(workspaceRoot, "project", "pixel.png"),
    );
    expect(image).toMatchObject({ kind: "image", mime: "image/png" });
    if (image.kind === "image") {
      expect(image.dataUrl).toMatch(/^data:image\/png;base64,/);
    }
  });

  it("reports binary files without decoding them", async () => {
    const binary = await readFilePreview(
      path.join(workspaceRoot, "project", "blob.bin"),
    );
    expect(binary.kind).toBe("binary");
  });

  it("refuses sensitive file names even though they are listed", async () => {
    await expect(
      readFilePreview(path.join(workspaceRoot, "project", ".env.local")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      readFilePreview(path.join(workspaceRoot, "project", "id_rsa")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("caps oversized text previews at the configured limit", async () => {
    const bigPath = path.join(workspaceRoot, "big.txt");
    await writeFile(bigPath, "a".repeat(MAX_TEXT_PREVIEW_BYTES + 100));
    const preview = await readFilePreview(bigPath);
    expect(preview).toMatchObject({ kind: "text", truncated: true });
    if (preview.kind === "text") {
      expect(preview.content.length).toBe(MAX_TEXT_PREVIEW_BYTES);
    }
  });
});

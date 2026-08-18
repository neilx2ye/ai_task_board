import "server-only";

import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AppError } from "@/lib/domain/errors";
import {
  chunkLooksBinary,
  ignoredDirectories,
  imageMimeFor,
  isHiddenEntry,
  isImageExtension,
  isSensitiveFileName,
  isTextFile,
} from "@/lib/file-kinds";
import type {
  FileExplorerDirectory,
  FileExplorerEntry,
  FileExplorerProjects,
  FilePreview,
} from "@/lib/types/domain";

/** 文本预览的最大字节数；更大的文件只返回开头部分。 */
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
/** 图片预览的最大字节数；更大的图片不做 base64 传输。 */
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;
/** 单个目录列表最多返回的条目数。 */
export const MAX_DIRECTORY_ENTRIES = 1000;
/** 候选项目路径最多返回的数量。 */
export const MAX_PROJECT_SUGGESTIONS = 200;
/** 二进制嗅探读取的头部字节数。 */
const BINARY_SNIFF_BYTES = 8192;
/** 目录条目排序器：复用同一个 Collator，避免每次排序都重新构造。 */
const entryCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

let allowedRootsPromise: Promise<string[]> | null = null;

function fsErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? error.message
    : fallback;
}

function mapFileSystemError(error: unknown): AppError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new AppError("PATH_NOT_FOUND", "路径不存在或已被移除");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new AppError("FORBIDDEN", "没有权限访问该路径");
  }
  if (code === "ENAMETOOLONG") {
    return new AppError("INVALID_REQUEST", "路径过长");
  }
  return new AppError(
    "INTERNAL_ERROR",
    `无法读取文件系统：${fsErrorMessage(error, "未知错误")}`,
  );
}

async function resolveAllowedRoots(): Promise<string[]> {
  const candidates = (process.env.FILE_EXPLORER_ROOTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const fallback = candidates.length > 0 ? candidates : [os.homedir(), process.cwd()];

  const roots: string[] = [];
  for (const candidate of fallback) {
    try {
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (info.isDirectory() && !roots.includes(resolved)) roots.push(resolved);
    } catch {
      // 不存在的候选根目录直接跳过。
    }
  }
  if (roots.length === 0) {
    throw new AppError(
      "FORBIDDEN",
      "没有可浏览的文件根目录，请通过 FILE_EXPLORER_ROOTS 配置",
    );
  }
  return roots;
}

/**
 * 允许浏览的根目录只在进程生命周期内解析一次；配置变更需要重启服务。
 * 解析失败时清空缓存，让下一次请求可以重试。
 */
async function allowedRoots(): Promise<string[]> {
  if (!allowedRootsPromise) {
    allowedRootsPromise = resolveAllowedRoots().catch((error) => {
      allowedRootsPromise = null;
      throw error;
    });
  }
  return allowedRootsPromise;
}

/**
 * 校验并规范化用户传入的路径：必须绝对、必须真实存在、必须位于允许的根目录内。
 * realpath 会解析符号链接，因此指向根目录之外的软链也会被拒绝。
 */
async function assertPathWithinRoots(
  rawPath: string,
  expected: "file" | "directory",
): Promise<string> {
  if (!rawPath || rawPath.length > 4096) {
    throw new AppError("INVALID_REQUEST", "请输入有效的绝对路径");
  }
  if (!path.isAbsolute(rawPath)) {
    throw new AppError("INVALID_REQUEST", "请使用绝对路径");
  }

  let resolved: string;
  try {
    resolved = await realpath(rawPath);
  } catch (error) {
    throw mapFileSystemError(error);
  }

  const info = await stat(resolved).catch((error) => {
    throw mapFileSystemError(error);
  });
  if (expected === "directory" && !info.isDirectory()) {
    throw new AppError("INVALID_REQUEST", "该路径不是目录");
  }
  if (expected === "file" && !info.isFile()) {
    throw new AppError("INVALID_REQUEST", "该路径不是普通文件");
  }

  const roots = await allowedRoots();
  const contained = roots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!contained) {
    throw new AppError("FORBIDDEN", "路径不在允许浏览的根目录范围内");
  }
  return resolved;
}

/** 软检查：路径真实存在且位于允许根目录内；不满足时返回 false 而不抛错。 */
export async function pathExistsWithinRoots(rawPath: string): Promise<boolean> {
  if (!rawPath || rawPath.length > 4096 || !path.isAbsolute(rawPath)) {
    return false;
  }
  try {
    const resolved = await realpath(rawPath);
    const info = await stat(resolved);
    if (!info.isDirectory() && !info.isFile()) return false;
    const roots = await allowedRoots();
    return roots.some((root) => {
      const relative = path.relative(root, resolved);
      return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
      );
    });
  } catch {
    return false;
  }
}

function sortEntries(entries: FileExplorerEntry[]): void {
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return entryCollator.compare(left.name, right.name);
  });
}

export async function listDirectoryContents(
  rawPath: string,
): Promise<FileExplorerDirectory> {
  const dirPath = await assertPathWithinRoots(rawPath, "directory");
  const dirents = await readdir(dirPath, { withFileTypes: true }).catch(
    (error) => {
      throw mapFileSystemError(error);
    },
  );
  const ignored = ignoredDirectories();
  const visible = dirents.filter((entry) => {
    if (entry.isSymbolicLink() || isHiddenEntry(entry.name)) return false;
    if (entry.isDirectory() && ignored.has(entry.name.toLowerCase())) {
      return false;
    }
    return entry.isFile() || entry.isDirectory();
  });

  const truncated = visible.length > MAX_DIRECTORY_ENTRIES;
  const selected = truncated ? visible.slice(0, MAX_DIRECTORY_ENTRIES) : visible;
  const entries = await Promise.all(
    selected.map(async (entry): Promise<FileExplorerEntry> => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: entryPath,
          type: "directory",
          size: null,
          modifiedAt: null,
        };
      }
      try {
        const info = await stat(entryPath);
        return {
          name: entry.name,
          path: entryPath,
          type: "file",
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      } catch {
        return {
          name: entry.name,
          path: entryPath,
          type: "file",
          size: null,
          modifiedAt: null,
        };
      }
    }),
  );
  sortEntries(entries);

  return {
    path: dirPath,
    name: path.basename(dirPath) || dirPath,
    entries,
    truncated,
  };
}

export async function listProjectSuggestions(): Promise<
  Omit<FileExplorerProjects, "bridgeProjects">
> {
  const roots = await allowedRoots();
  const projects = new Map<string, { name: string; path: string }>();

  for (const root of roots) {
    const dirents = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    const ignored = ignoredDirectories();
    for (const entry of dirents) {
      if (projects.size >= MAX_PROJECT_SUGGESTIONS) break;
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        isHiddenEntry(entry.name) ||
        ignored.has(entry.name.toLowerCase())
      ) {
        continue;
      }
      const entryPath = path.join(root, entry.name);
      projects.set(entryPath, { name: entry.name, path: entryPath });
    }
  }

  const projectList = [...projects.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    }),
  );
  return { roots, projects: projectList };
}

async function readLeadingChunk(
  filePath: string,
  length: number,
): Promise<Uint8Array> {
  const handle = await open(filePath, "r").catch((error) => {
    throw mapFileSystemError(error);
  });
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 以严格 UTF-8 解码；结尾被截断的多字节字符做宽容回退。 */
function decodeUtf8(bytes: Uint8Array): string | null {
  for (let drop = 0; drop <= 3; drop += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytes.length - drop),
      );
    } catch {
      // 继续裁掉结尾的 1 个字节再试。
    }
  }
  return null;
}

export async function readFilePreview(rawPath: string): Promise<FilePreview> {
  const filePath = await assertPathWithinRoots(rawPath, "file");
  const name = path.basename(filePath);
  if (isHiddenEntry(name) || isSensitiveFileName(name)) {
    throw new AppError("FORBIDDEN", "该文件不允许预览");
  }

  const info = await stat(filePath).catch((error) => {
    throw mapFileSystemError(error);
  });
  const modifiedAt = info.mtime.toISOString();
  const extension = path.extname(name).slice(1).toLowerCase();

  if (isImageExtension(extension)) {
    if (info.size > MAX_IMAGE_PREVIEW_BYTES) {
      return {
        kind: "binary",
        name,
        path: filePath,
        size: info.size,
        modifiedAt,
        mime: imageMimeFor(extension),
        reason: `图片超过 ${Math.round(MAX_IMAGE_PREVIEW_BYTES / (1024 * 1024))} MB，无法在网页中预览`,
      };
    }
    const bytes = await readFile(filePath).catch((error) => {
      throw mapFileSystemError(error);
    });
    return {
      kind: "image",
      name,
      path: filePath,
      size: info.size,
      modifiedAt,
      mime: imageMimeFor(extension) ?? "application/octet-stream",
      dataUrl: `data:${imageMimeFor(extension)};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  }

  const head = await readLeadingChunk(filePath, BINARY_SNIFF_BYTES);
  if (chunkLooksBinary(head)) {
    return {
      kind: "binary",
      name,
      path: filePath,
      size: info.size,
      modifiedAt,
      mime: null,
      reason: "二进制文件暂不支持预览",
    };
  }

  if (!isTextFile(name)) {
    const decoded = decodeUtf8(head);
    if (decoded === null) {
      return {
        kind: "binary",
        name,
        path: filePath,
        size: info.size,
        modifiedAt,
        mime: null,
        reason: "无法识别的文件类型",
      };
    }
  }

  const truncated = info.size > MAX_TEXT_PREVIEW_BYTES;
  const readLength = Math.min(info.size, MAX_TEXT_PREVIEW_BYTES + 3);
  const bytes = await readLeadingChunk(filePath, readLength);
  const decodedRaw = decodeUtf8(bytes.subarray(0, readLength));
  if (decodedRaw === null) {
    return {
      kind: "binary",
      name,
      path: filePath,
      size: info.size,
      modifiedAt,
      mime: null,
      reason: "文件不是有效的 UTF-8 文本",
    };
  }
  const content = truncated
    ? decodedRaw.slice(0, MAX_TEXT_PREVIEW_BYTES)
    : decodedRaw;

  return {
    kind: "text",
    name,
    path: filePath,
    size: info.size,
    modifiedAt,
    content,
    truncated,
  };
}

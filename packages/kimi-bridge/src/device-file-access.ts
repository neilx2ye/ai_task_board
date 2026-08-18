import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** 只需工作目录路径的结构化引用，避免与各运行时的配置类型耦合。 */
type ManagedDirectoryRef = {
  workingDirectory: string;
};

export type DeviceFileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  modifiedAt: string | null;
};

export type DeviceFileListResult = {
  path: string;
  name: string;
  entries: DeviceFileEntry[];
  truncated: boolean;
};

export type DeviceFilePreviewResult =
  | {
      kind: "text";
      name: string;
      path: string;
      size: number;
      modifiedAt: string | null;
      content: string;
      truncated: boolean;
    }
  | {
      kind: "image";
      name: string;
      path: string;
      size: number;
      modifiedAt: string | null;
      mime: string;
      dataUrl: string;
    }
  | {
      kind: "binary";
      name: string;
      path: string;
      size: number | null;
      modifiedAt: string | null;
      mime: string | null;
      reason: string;
    };

export const DEVICE_MAX_DIRECTORY_ENTRIES = 1000;
export const DEVICE_MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
export const DEVICE_MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;

const BINARY_SNIFF_BYTES = 8192;

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  ".cache",
  ".npm",
  ".turbo",
  ".pytest_cache",
  "coverage",
]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "log",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "cnf",
  "properties",
  "xml",
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "vue",
  "svelte",
  "astro",
  "py",
  "pyw",
  "rb",
  "rake",
  "gemspec",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "swift",
  "m",
  "mm",
  "php",
  "phtml",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "prisma",
  "gradle",
  "lock",
  "csv",
  "tsv",
  "diff",
  "patch",
  "rst",
  "tex",
  "bib",
  "nix",
  "dotenv",
]);

const TEXT_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "license",
  "licence",
  "readme",
  "changelog",
  "contributing",
  "authors",
  "todo",
  "justfile",
  "procfile",
]);

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..*)?$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.pypirc$/,
  /^\.htpasswd$/,
  /^\.git-credentials$/,
  /^\.docker\.config\.json$/,
  /^id_rsa(\..*)?$/,
  /^id_ed25519(\..*)?$/,
  /^id_dsa(\..*)?$/,
  /^id_ecdsa(\..*)?$/,
  /^authorized_keys$/,
  /^known_hosts$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/,
  /^(credentials|secrets?|passwords?)(\..*)?$/,
  /\.(credential|credentials|secret|secrets)$/,
] as const;

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

function isHiddenEntry(name: string): boolean {
  return name.startsWith(".");
}

function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function isTextFile(name: string): boolean {
  const base = path.basename(name).toLowerCase();
  return TEXT_EXTENSIONS.has(extensionOf(name)) || TEXT_BASENAMES.has(base);
}

function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

function imageMimeFor(extension: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[extension.toLowerCase()] ?? null;
}

function chunkLooksBinary(chunk: Uint8Array): boolean {
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] === 0) return true;
  }
  return false;
}

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

function sortEntries(entries: DeviceFileEntry[]): void {
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/**
 * 校验并规范化设备端路径：必须绝对、真实存在，且位于当前 Bridge 的
 * 受管工作目录白名单内；realpath 会解析符号链接，阻止软链逃逸。
 */
export async function assertManagedDevicePath(
  directories: readonly ManagedDirectoryRef[],
  rawPath: string,
): Promise<string> {
  if (!rawPath || rawPath.length > 4096 || !path.isAbsolute(rawPath)) {
    throw new Error("请使用有效的工作目录内绝对路径");
  }

  let resolved: string;
  try {
    resolved = await realpath(rawPath);
  } catch {
    throw new Error("路径不存在或无法访问");
  }

  const contained = directories.some((directory) => {
    const root = path.resolve(directory.workingDirectory);
    const relative = path.relative(root, resolved);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
  if (!contained) {
    throw new Error("路径不在当前 Bridge 的本机工作目录白名单内");
  }
  return resolved;
}

export async function listDeviceDirectory(
  directories: readonly ManagedDirectoryRef[],
  rawPath: string,
): Promise<DeviceFileListResult> {
  const dirPath = await assertManagedDevicePath(directories, rawPath);
  const info = await stat(dirPath).catch(() => {
    throw new Error("目录不存在或无法访问");
  });
  if (!info.isDirectory()) throw new Error("该路径不是目录");

  const dirents = await readdir(dirPath, { withFileTypes: true }).catch(() => {
    throw new Error("目录读取失败");
  });
  const visible = dirents.filter((entry) => {
    if (entry.isSymbolicLink() || isHiddenEntry(entry.name)) return false;
    if (
      entry.isDirectory() &&
      DEFAULT_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())
    ) {
      return false;
    }
    return entry.isFile() || entry.isDirectory();
  });

  const truncated = visible.length > DEVICE_MAX_DIRECTORY_ENTRIES;
  const selected = truncated
    ? visible.slice(0, DEVICE_MAX_DIRECTORY_ENTRIES)
    : visible;
  const entries = await Promise.all(
    selected.map(async (entry): Promise<DeviceFileEntry> => {
      const entryPath = path.join(dirPath, entry.name);
      try {
        const entryInfo = await stat(entryPath);
        return {
          name: entry.name,
          path: entryPath,
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isDirectory() ? null : entryInfo.size,
          modifiedAt: entryInfo.mtime.toISOString(),
        };
      } catch {
        return {
          name: entry.name,
          path: entryPath,
          type: entry.isDirectory() ? "directory" : "file",
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

async function readLeadingChunk(
  filePath: string,
  length: number,
): Promise<Uint8Array> {
  const handle = await open(filePath, "r").catch(() => {
    throw new Error("文件读取失败");
  });
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readDeviceFilePreview(
  directories: readonly ManagedDirectoryRef[],
  rawPath: string,
): Promise<DeviceFilePreviewResult> {
  const filePath = await assertManagedDevicePath(directories, rawPath);
  const name = path.basename(filePath);
  if (isHiddenEntry(name) || isSensitiveFileName(name)) {
    throw new Error("该文件不允许预览");
  }

  const info = await stat(filePath).catch(() => {
    throw new Error("文件不存在或无法访问");
  });
  if (!info.isFile()) throw new Error("该路径不是普通文件");

  const modifiedAt = info.mtime.toISOString();
  const extension = path.extname(name).slice(1).toLowerCase();

  if (isImageExtension(extension)) {
    if (info.size > DEVICE_MAX_IMAGE_PREVIEW_BYTES) {
      return {
        kind: "binary",
        name,
        path: filePath,
        size: info.size,
        modifiedAt,
        mime: imageMimeFor(extension),
        reason: `图片超过 ${Math.round(DEVICE_MAX_IMAGE_PREVIEW_BYTES / (1024 * 1024))} MB，无法在网页中预览`,
      };
    }
    const bytes = await readFile(filePath).catch(() => {
      throw new Error("图片读取失败");
    });
    const mime = imageMimeFor(extension);
    if (!mime) throw new Error("无法识别的图片类型");
    return {
      kind: "image",
      name,
      path: filePath,
      size: info.size,
      modifiedAt,
      mime,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
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

  const truncated = info.size > DEVICE_MAX_TEXT_PREVIEW_BYTES;
  const readLength = Math.min(info.size, DEVICE_MAX_TEXT_PREVIEW_BYTES + 3);
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

  return {
    kind: "text",
    name,
    path: filePath,
    size: info.size,
    modifiedAt,
    content: truncated
      ? decodedRaw.slice(0, DEVICE_MAX_TEXT_PREVIEW_BYTES)
      : decodedRaw,
    truncated,
  };
}

import path from "node:path";

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

/** 无扩展名但内容为文本的常见文件名（小写）。 */
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

/** 明文读取的敏感文件黑名单：无论扩展名如何都拒绝预览内容。 */
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

const DEFAULT_IGNORED_DIRECTORIES = [
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
];

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isHiddenEntry(name: string): boolean {
  return name.startsWith(".");
}

export function ignoredDirectories(): Set<string> {
  const configured = (process.env.FILE_EXPLORER_IGNORED_DIRECTORIES ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return new Set(
    configured.length > 0 ? configured : DEFAULT_IGNORED_DIRECTORIES,
  );
}

export function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export function isMarkdownFile(name: string): boolean {
  return ["md", "markdown", "mdx"].includes(extensionOf(name));
}

export function isTextFile(name: string): boolean {
  const base = path.basename(name).toLowerCase();
  return TEXT_EXTENSIONS.has(extensionOf(name)) || TEXT_BASENAMES.has(base);
}

export function imageMimeFor(extension: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[extension.toLowerCase()] ?? null;
}

/** 头部字节包含 NUL 时视为二进制内容。 */
export function chunkLooksBinary(chunk: Uint8Array): boolean {
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] === 0) return true;
  }
  return false;
}

import path from "node:path";

const DIRECTORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_DIRECTORIES = 100;
const MAX_DIRECTORY_NAME_LENGTH = 200;
const MAX_DIRECTORY_PATH_LENGTH = 4_096;

export type ManagedWorkingDirectory = {
  key: string;
  name: string;
  workingDirectory: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseWorkingDirectories(
  value: string | undefined,
  fallbackWorkingDirectory: string,
): ManagedWorkingDirectory[] {
  const fallback = path.resolve(fallbackWorkingDirectory);
  if (!value?.trim()) {
    return [
      {
        key: "default",
        name: path.basename(fallback) || fallback,
        workingDirectory: fallback,
      },
    ];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CODEX_WORKING_DIRECTORIES 必须是合法 JSON 数组");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > MAX_DIRECTORIES
  ) {
    throw new Error("CODEX_WORKING_DIRECTORIES 必须包含 1 到 100 个目录");
  }

  const keys = new Set<string>();
  const paths = new Set<string>();
  return parsed.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`CODEX_WORKING_DIRECTORIES[${index}] 必须是对象`);
    }
    const unknownField = Object.keys(item).find(
      (field) => !["key", "name", "path"].includes(field),
    );
    const key = nonEmptyString(item.key);
    const configuredPath = nonEmptyString(item.path);
    if (unknownField || !key || !DIRECTORY_KEY_PATTERN.test(key)) {
      throw new Error(`CODEX_WORKING_DIRECTORIES[${index}].key 格式无效`);
    }
    if (
      !configuredPath ||
      configuredPath.length > MAX_DIRECTORY_PATH_LENGTH
    ) {
      throw new Error(
        `CODEX_WORKING_DIRECTORIES[${index}].path 必须是有效路径`,
      );
    }
    const workingDirectory = path.resolve(configuredPath);
    if (item.name !== undefined && !nonEmptyString(item.name)) {
      throw new Error(
        `CODEX_WORKING_DIRECTORIES[${index}].name 必须是非空字符串`,
      );
    }
    const name =
      nonEmptyString(item.name) || path.basename(workingDirectory) || key;
    if (name.length > MAX_DIRECTORY_NAME_LENGTH) {
      throw new Error(
        `CODEX_WORKING_DIRECTORIES[${index}].name 不能超过 200 个字符`,
      );
    }
    if (keys.has(key)) {
      throw new Error(`CODEX_WORKING_DIRECTORIES 包含重复 key：${key}`);
    }
    if (paths.has(workingDirectory)) {
      throw new Error(
        `CODEX_WORKING_DIRECTORIES 包含重复路径：${workingDirectory}`,
      );
    }
    keys.add(key);
    paths.add(workingDirectory);
    return { key, name, workingDirectory };
  });
}

export function isExactWorkingDirectory(
  candidate: string,
  configured: string,
): boolean {
  return path.relative(path.resolve(configured), path.resolve(candidate)) === "";
}

export function managedDirectoryForWorkingDirectory(
  workingDirectory: string | null,
  configuredDirectories: readonly ManagedWorkingDirectory[],
): ManagedWorkingDirectory | null {
  if (!workingDirectory) return null;
  return (
    configuredDirectories.find((directory) =>
      isExactWorkingDirectory(
        workingDirectory,
        directory.workingDirectory,
      ),
    ) ?? null
  );
}

export function workingDirectoryForThreadCreate(
  directoryKey: string | null,
  configuredDirectories: readonly ManagedWorkingDirectory[],
  fallbackWorkingDirectory: string,
): string {
  if (!directoryKey) return fallbackWorkingDirectory;
  const directory = configuredDirectories.find(
    (candidate) => candidate.key === directoryKey,
  );
  if (!directory) {
    throw new Error("目标工作目录不在当前 Bridge 的本机白名单中");
  }
  return directory.workingDirectory;
}

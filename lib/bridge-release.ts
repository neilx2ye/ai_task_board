import "server-only";

const REGISTRY_BASE = (
  process.env.AI_TASK_BOARD_NPM_REGISTRY ?? "https://registry.npmjs.org"
).replace(/\/+$/, "");
const PACKAGE_NAME = "ai-task-board-bridge";
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 3_000;

let latestCache: { latest: string | null; expiresAt: number } | null = null;
const versionCache = new Map<
  string,
  { exists: boolean; expiresAt: number }
>();

async function fetchRegistryJson(pathname: string): Promise<unknown | null> {
  try {
    const response = await fetch(`${REGISTRY_BASE}/${pathname}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** npm 上 ai-task-board-bridge 的最新发布版本；查询失败时返回 null（5 分钟缓存）。 */
export async function getLatestBridgeRelease(): Promise<string | null> {
  if (latestCache && latestCache.expiresAt > Date.now()) {
    return latestCache.latest;
  }
  const body = (await fetchRegistryJson(`${PACKAGE_NAME}/latest`)) as {
    version?: unknown;
  } | null;
  const latest =
    body && typeof body.version === "string" ? body.version : null;
  latestCache = { latest, expiresAt: Date.now() + CACHE_TTL_MS };
  return latest;
}

/** 精确校验某个版本是否真实发布过（404 → false，其它失败同样按 false 处理）。 */
export async function bridgeReleaseExists(version: string): Promise<boolean> {
  const cached = versionCache.get(version);
  if (cached && cached.expiresAt > Date.now()) return cached.exists;

  const body = (await fetchRegistryJson(
    `${PACKAGE_NAME}/${encodeURIComponent(version)}`,
  )) as { version?: unknown } | null;
  const exists =
    body !== null &&
    typeof body.version === "string" &&
    body.version === version;
  versionCache.set(version, {
    exists,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return exists;
}

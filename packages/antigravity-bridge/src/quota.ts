import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Provider-neutral quota snapshot understood by the Board sync API. */
export type SyncedQuota = {
  provider: "codex" | "kimi" | "antigravity";
  status: "ok" | "unavailable" | "error";
  message: string | null;
  account: string | null;
  plan: string | null;
  fetched_at: string;
  buckets: SyncedQuotaBucket[];
  credits: SyncedQuotaCredits | null;
};

export type SyncedQuotaBucket = {
  id: string;
  label: string;
  remaining_percent: number | null;
  used_percent: number | null;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resets_at: string | null;
  unlimited: boolean;
  description: string | null;
};

export type SyncedQuotaCredits = {
  balance: string | null;
  has_credits: boolean;
  unlimited: boolean;
  available_resets: number | null;
  description: string | null;
};

export type AntigravityQuotaOptions = {
  stateDir: string;
  codeAssistBaseUrl: string;
  agyBinary: string;
  signal?: AbortSignal;
};

const REQUEST_TIMEOUT_MS = 12_000;
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

type TokenFile = {
  auth_method?: string;
  access_token?: string;
  refresh_token?: string;
  expiry?: string;
  token?: {
    access_token?: string;
    refresh_token?: string;
    expiry?: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteFraction(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function tokenPath(stateDir: string): string {
  return path.join(stateDir, "antigravity-oauth-token");
}

async function readToken(stateDir: string): Promise<{
  file: string;
  accessToken: string;
  refreshToken: string | null;
  expiry: number | null;
  raw: Record<string, unknown>;
} | null> {
  const file = tokenPath(stateDir);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(parsed)) return null;
    const nested = isRecord(parsed.token)
      ? (parsed.token as TokenFile["token"])
      : null;
    const accessToken =
      (typeof parsed.access_token === "string" && parsed.access_token) ||
      (nested?.access_token ?? "");
    if (!accessToken) return null;
    const refreshToken =
      (typeof parsed.refresh_token === "string" && parsed.refresh_token) ||
      (nested?.refresh_token ?? null);
    const expiryValue =
      (typeof parsed.expiry === "string" && parsed.expiry) ||
      (nested?.expiry ?? "");
    const expiry = expiryValue ? Date.parse(expiryValue) : NaN;
    return {
      file,
      accessToken,
      refreshToken,
      expiry: Number.isFinite(expiry) ? expiry : null,
      raw: parsed,
    };
  } catch {
    return null;
  }
}

function resolveBinary(binary: string): string | null {
  if (path.isAbsolute(binary)) return binary;
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  const resolved = result.stdout?.trim();
  return resolved || null;
}

function oauthClientCandidates(binary: string): Array<[string, string]> {
  let data: string;
  try {
    const resolved = resolveBinary(binary);
    if (!resolved) return [];
    data = readFileSyncBuffer(resolved);
  } catch {
    return [];
  }
  const clientIds =
    data.match(/\d+-[a-z0-9]+\.apps\.googleusercontent\.com/g) ?? [];
  const secrets = data.match(/GOCSPX-[A-Za-z0-9_-]{28}/g) ?? [];
  const candidates: Array<[string, string]> = [];
  for (const clientId of [...clientIds].reverse()) {
    for (const secret of secrets) {
      candidates.push([clientId, secret]);
    }
  }
  return candidates;
}

function readFileSyncBuffer(file: string): string {
  return readFileSync(file, "latin1");
}

async function writeToken(
  file: string,
  raw: Record<string, unknown>,
  accessToken: string,
  expiry: string,
): Promise<void> {
  const updated = isRecord(raw.token)
    ? {
        ...raw,
        token: { ...raw.token, access_token: accessToken, expiry },
      }
    : { ...raw, access_token: accessToken, expiry };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(updated, null, 2), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function postJson(
  url: string,
  payload: Record<string, unknown>,
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "antigravity/cli (aidev_client; os_type=linux)",
      },
      body: JSON.stringify(payload),
    },
    signal,
  );
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, payload: body };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function refreshAccessToken(
  refreshToken: string,
  binary: string,
  signal?: AbortSignal,
): Promise<{ accessToken: string; expiresAt: number }> {
  for (const [clientId, clientSecret] of oauthClientCandidates(binary)) {
    const response = await fetchWithTimeout(
      OAUTH_TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      },
      signal,
    );
    if (!response.ok) continue;
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || typeof payload.access_token !== "string") {
      continue;
    }
    const expiresIn =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3_600;
    return {
      accessToken: payload.access_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    };
  }
  throw new Error("无法刷新 Antigravity OAuth 凭据");
}

export function normalizeAntigravityQuota(
  payload: unknown,
  plan: string | null,
  now = new Date(),
): SyncedQuota {
  if (!isRecord(payload) || !Array.isArray(payload.groups)) {
    return {
      provider: "antigravity",
      status: "error",
      message: "Antigravity 额度接口返回了无法识别的数据",
      account: null,
      plan,
      fetched_at: now.toISOString(),
      buckets: [],
      credits: null,
    };
  }
  const buckets: SyncedQuotaBucket[] = [];
  payload.groups.forEach((rawGroup, groupIndex) => {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.buckets)) return;
    const groupName =
      typeof rawGroup.displayName === "string" && rawGroup.displayName
        ? rawGroup.displayName
        : `组 ${groupIndex + 1}`;
    rawGroup.buckets.forEach((rawBucket, bucketIndex) => {
      if (!isRecord(rawBucket) || rawBucket.disabled === true) return;
      const displayName =
        typeof rawBucket.displayName === "string" && rawBucket.displayName
          ? rawBucket.displayName
          : typeof rawBucket.bucketId === "string" && rawBucket.bucketId
            ? rawBucket.bucketId
            : "额度窗口";
      const fraction = finiteFraction(rawBucket.remainingFraction);
      buckets.push({
        id: `${groupName}:${
          typeof rawBucket.bucketId === "string" && rawBucket.bucketId
            ? rawBucket.bucketId
            : bucketIndex
        }`,
        label: displayName,
        remaining_percent:
          fraction === null ? null : Math.round(fraction * 1_000) / 10,
        used_percent:
          fraction === null ? null : Math.round((1 - fraction) * 1_000) / 10,
        limit: null,
        used: null,
        remaining: null,
        resets_at:
          typeof rawBucket.resetTime === "string" ? rawBucket.resetTime : null,
        unlimited: false,
        description: groupName,
      });
    });
  });
  return {
    provider: "antigravity",
    status: buckets.length ? "ok" : "unavailable",
    message: buckets.length ? null : "当前账户暂未返回模型额度窗口",
    account: null,
    plan,
    fetched_at: now.toISOString(),
    buckets,
    credits: null,
  };
}

export async function fetchAntigravityQuota(
  options: AntigravityQuotaOptions,
  now = new Date(),
): Promise<SyncedQuota> {
  const token = await readToken(options.stateDir);
  if (!token) {
    return {
      provider: "antigravity",
      status: "unavailable",
      message: "未找到 Antigravity CLI 登录凭据，请先运行 agy 登录",
      account: null,
      plan: null,
      fetched_at: now.toISOString(),
      buckets: [],
      credits: null,
    };
  }

  let accessToken = token.accessToken;
  const needsRefresh = token.expiry !== null && token.expiry - now.getTime() < 60_000;
  if (needsRefresh && token.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(
        token.refreshToken,
        options.agyBinary,
        options.signal,
      );
      accessToken = refreshed.accessToken;
      await writeToken(
        token.file,
        token.raw,
        refreshed.accessToken,
        new Date(refreshed.expiresAt).toISOString(),
      );
    } catch (error) {
      process.stderr.write(
        `刷新 Antigravity 凭据失败，尝试使用现有令牌：${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  const base = options.codeAssistBaseUrl.replace(/\/+$/, "");
  try {
    const load = await postJson(
      `${base}:loadCodeAssist`,
      { metadata: { ideType: "ANTIGRAVITY" } },
      accessToken,
      options.signal,
    );
    if (
      (load.status === 401 || load.status === 403) &&
      token.refreshToken &&
      accessToken === token.accessToken
    ) {
      const refreshed = await refreshAccessToken(
        token.refreshToken,
        options.agyBinary,
        options.signal,
      );
      accessToken = refreshed.accessToken;
      await writeToken(
        token.file,
        token.raw,
        refreshed.accessToken,
        new Date(refreshed.expiresAt).toISOString(),
      );
      return fetchAntigravityQuota(options, now);
    }
    if (!load.payload || !isRecord(load.payload)) {
      throw new Error(`Antigravity Code Assist 接口失败：HTTP ${load.status}`);
    }
    const project = load.payload.cloudaicompanionProject;
    if (typeof project !== "string" || !project) {
      throw new Error("Antigravity 未返回可用的 Code Assist 项目");
    }
    const plan = isRecord(load.payload.paidTier) &&
      typeof load.payload.paidTier.name === "string"
      ? load.payload.paidTier.name
      : null;
    const summary = await postJson(
      `${base}:retrieveUserQuotaSummary`,
      { project },
      accessToken,
      options.signal,
    );
    if (summary.status !== 200) {
      return {
        provider: "antigravity",
        status: "error",
        message: `Antigravity 额度接口失败：HTTP ${summary.status}`,
        account: null,
        plan,
        fetched_at: now.toISOString(),
        buckets: [],
        credits: null,
      };
    }
    return normalizeAntigravityQuota(summary.payload, plan, now);
  } catch (error) {
    return {
      provider: "antigravity",
      status: "error",
      message: error instanceof Error ? error.message : "Antigravity 额度获取失败",
      account: null,
      plan: null,
      fetched_at: now.toISOString(),
      buckets: [],
      credits: null,
    };
  }
}

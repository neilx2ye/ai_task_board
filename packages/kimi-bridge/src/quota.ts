import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export type KimiQuotaOptions = {
  shareDir: string;
  oauthHost: string;
  codeBaseUrl: string;
  signal?: AbortSignal;
};

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const REQUEST_TIMEOUT_MS = 10_000;

type KimiUsageDetail = {
  name?: string | null | undefined;
  limit?: string | number | null | undefined;
  used?: string | number | null | undefined;
  remaining?: string | number | null | undefined;
  resetTime?: string | null | undefined;
  resetAt?: string | null | undefined;
  reset_time?: string | null | undefined;
};

type KimiUsage = {
  usage?: KimiUsageDetail | null;
  limits?: Array<{
    name?: string | null | undefined;
    scope?: string | null | undefined;
    window?: {
      duration?: number | null | undefined;
      timeUnit?: string | null | undefined;
    } | null;
    detail?: KimiUsageDetail | null;
  }> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function percentFromRemaining(remaining: number | null, limit: number | null): number | null {
  if (remaining === null || limit === null || limit <= 0) return null;
  return Math.round(Math.min(100, Math.max(0, (remaining / limit) * 100)) * 10) / 10;
}

function bucketFromDetail(
  detail: KimiUsageDetail | null | undefined,
  id: string,
  fallbackLabel: string,
): SyncedQuotaBucket {
  const source = detail ?? {};
  const limit = toNumber(source.limit);
  let remaining = toNumber(source.remaining);
  let used = toNumber(source.used);
  if (remaining === null && limit !== null && used !== null) {
    remaining = Math.max(0, limit - used);
  }
  if (used === null && limit !== null && remaining !== null) {
    used = Math.max(0, limit - remaining);
  }
  const remainingPercent = percentFromRemaining(remaining, limit);
  return {
    id,
    label:
      (typeof source.name === "string" && source.name.trim()) || fallbackLabel,
    remaining_percent: remainingPercent,
    used_percent: remainingPercent === null ? null : Math.round((100 - remainingPercent) * 10) / 10,
    limit,
    used,
    remaining,
    resets_at: source.resetTime || source.resetAt || source.reset_time || null,
    unlimited: false,
    description: null,
  };
}

export function normalizeKimiQuota(
  value: unknown,
  now = new Date(),
): SyncedQuota {
  if (!isRecord(value)) {
    return {
      provider: "kimi",
      status: "error",
      message: "Kimi 用量接口返回了无法识别的数据",
      account: null,
      plan: null,
      fetched_at: now.toISOString(),
      buckets: [],
      credits: null,
    };
  }
  const payload = value as unknown as KimiUsage;
  const buckets: SyncedQuotaBucket[] = [];
  if (isRecord(payload.usage)) {
    buckets.push(
      bucketFromDetail(payload.usage, "weekly", "周期额度"),
    );
  }
  payload.limits?.forEach((item, index) => {
    if (!isRecord(item)) return;
    const detail = isRecord(item.detail)
      ? (item.detail as KimiUsageDetail)
      : item;
    const window = isRecord(item.window) ? item.window : {};
    const duration = toNumber(window.duration);
    const unit = typeof window.timeUnit === "string" ? window.timeUnit : "";
    const fallbackLabel = duration
      ? `${duration}${unit.includes("MINUTE") ? " 分钟" : unit.includes("HOUR") ? " 小时" : unit.includes("DAY") ? " 天" : ""}限额`
      : `限额 ${index + 1}`;
    buckets.push(
      bucketFromDetail(
        detail ?? {
          name: item.name,
          limit: undefined,
          used: undefined,
          remaining: undefined,
          resetTime: undefined,
        },
        `rate-limit-${index + 1}`,
        fallbackLabel,
      ),
    );
  });
  return {
    provider: "kimi",
    status: "ok",
    message: null,
    account: null,
    plan: null,
    fetched_at: now.toISOString(),
    buckets,
    credits: null,
  };
}

function credentialFiles(shareDir: string): string[] {
  return [
    path.join(shareDir, "credentials", "kimi-code.json"),
    path.join(os.homedir(), ".kimi-code", "credentials", "kimi-code.json"),
    path.join(os.homedir(), ".kimi", "credentials", "kimi-code.json"),
  ];
}

async function readCredentials(shareDir: string): Promise<{
  file: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  raw: Record<string, unknown>;
} | null> {
  const files = [...new Set(credentialFiles(shareDir))];
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isRecord(parsed)) continue;
      const tokenPayload = isRecord(parsed.token) ? parsed.token : parsed;
      const accessToken =
        typeof tokenPayload.access_token === "string"
          ? tokenPayload.access_token
          : "";
      const refreshToken =
        typeof tokenPayload.refresh_token === "string"
          ? tokenPayload.refresh_token
          : null;
      const expiresAt = toNumber(tokenPayload.expires_at);
      if (accessToken) {
        return {
          file,
          accessToken,
          refreshToken,
          expiresAt,
          raw: parsed,
        };
      }
    } catch {
      // The credential file can be missing or mid-write while the CLI starts.
    }
  }
  return null;
}

async function writeCredentials(
  file: string,
  raw: Record<string, unknown>,
  accessToken: string,
  expiresAt: number,
): Promise<void> {
  const updated = isRecord(raw.token) && raw.token
    ? {
        ...raw,
        token: { ...raw.token, access_token: accessToken, expires_at: expiresAt },
      }
    : { ...raw, access_token: accessToken, expires_at: expiresAt };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(updated, null, 2), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function refreshAccessToken(
  refreshToken: string,
  oauthHost: string,
  signal?: AbortSignal,
): Promise<{ accessToken: string; expiresAt: number }> {
  const response = await fetchWithTimeout(
    `${oauthHost.replace(/\/+$/, "")}/api/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: KIMI_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(`Kimi 令牌刷新失败：HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.access_token !== "string") {
    throw new Error("Kimi 令牌刷新返回了无法识别的数据");
  }
  const expiresIn = toNumber(payload.expires_in) ?? 3_600;
  return {
    accessToken: payload.access_token,
    expiresAt: Date.now() / 1_000 + expiresIn,
  };
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

export async function fetchKimiQuota(
  options: KimiQuotaOptions,
  now = new Date(),
): Promise<SyncedQuota> {
  const credentials = await readCredentials(options.shareDir);
  if (!credentials) {
    return {
      provider: "kimi",
      status: "unavailable",
      message: "未找到 Kimi Code CLI 登录凭据，请先运行 kimi login",
      account: null,
      plan: null,
      fetched_at: now.toISOString(),
      buckets: [],
      credits: null,
    };
  }

  let accessToken = credentials.accessToken;
  const needsRefresh =
    credentials.expiresAt === null ||
    credentials.expiresAt * 1_000 - now.getTime() < 60_000;
  if (needsRefresh && credentials.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(
        credentials.refreshToken,
        options.oauthHost,
        options.signal,
      );
      accessToken = refreshed.accessToken;
      await writeCredentials(
        credentials.file,
        credentials.raw,
        refreshed.accessToken,
        refreshed.expiresAt,
      );
    } catch (error) {
      process.stderr.write(
        `刷新 Kimi 凭据失败，尝试使用现有令牌：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  try {
    const response = await fetchWithTimeout(
      `${options.codeBaseUrl.replace(/\/+$/, "")}/usages`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      },
      options.signal,
    );
    if (response.status === 401 && credentials.refreshToken && accessToken === credentials.accessToken) {
      const refreshed = await refreshAccessToken(
        credentials.refreshToken,
        options.oauthHost,
        options.signal,
      );
      await writeCredentials(
        credentials.file,
        credentials.raw,
        refreshed.accessToken,
        refreshed.expiresAt,
      );
      return fetchKimiQuota(options, now);
    }
    if (!response.ok) {
      return {
        provider: "kimi",
        status: "error",
        message: `Kimi 用量接口失败：HTTP ${response.status}`,
        account: null,
        plan: null,
        fetched_at: now.toISOString(),
        buckets: [],
        credits: null,
      };
    }
    return normalizeKimiQuota(await response.json(), now);
  } catch (error) {
    return {
      provider: "kimi",
      status: "error",
      message: error instanceof Error ? error.message : "Kimi 额度获取失败",
      account: null,
      plan: null,
      fetched_at: now.toISOString(),
      buckets: [],
      credits: null,
    };
  }
}

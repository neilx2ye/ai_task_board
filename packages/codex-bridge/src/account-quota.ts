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

type RateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: {
    resetsAt?: number | null;
    usedPercent?: number | null;
    windowDurationMins?: number | null;
  } | null;
  secondary?: {
    resetsAt?: number | null;
    usedPercent?: number | null;
    windowDurationMins?: number | null;
  } | null;
  credits?: {
    balance?: string | null;
    hasCredits?: boolean;
    unlimited?: boolean;
  } | null;
  individualLimit?: {
    limit?: string | null;
    remainingPercent?: number | null;
    resetsAt?: number | null;
    used?: string | null;
  } | null;
};

export type CodexAccountRateLimits = {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits?: {
    availableCount?: number | null;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number < 0 || number > 100) return null;
  return number;
}

function epochToIso(value: unknown): string | null {
  const seconds = finiteNumber(value);
  if (seconds === null || !Number.isFinite(seconds * 1_000)) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function windowLabel(minutes: unknown, fallback: string): string {
  const value = finiteNumber(minutes);
  if (value === null || value < 1) return fallback;
  if (value >= 1_440 && value % 1_440 === 0) {
    return `${Math.round(value / 1_440)} 天`;
  }
  if (value >= 60 && value % 60 === 0) {
    return `${Math.round(value / 60)} 小时`;
  }
  return `${Math.round(value)} 分钟`;
}

function windowBucket(
  window: RateLimitSnapshot["primary"],
  id: string,
  fallbackLabel: string,
): SyncedQuotaBucket {
  const usedPercent = percent(window?.usedPercent);
  return {
    id,
    label: windowLabel(window?.windowDurationMins, fallbackLabel),
    remaining_percent:
      usedPercent === null ? null : Math.round((100 - usedPercent) * 10) / 10,
    used_percent: usedPercent,
    limit: null,
    used: null,
    remaining: null,
    resets_at: epochToIso(window?.resetsAt),
    unlimited: false,
    description: null,
  };
}

function snapshotToBuckets(
  snapshot: RateLimitSnapshot,
  key: string,
): SyncedQuotaBucket[] {
  const buckets: SyncedQuotaBucket[] = [];
  if (snapshot.primary) {
    buckets.push(windowBucket(snapshot.primary, `${key}:primary`, "短周期额度"));
  }
  if (snapshot.secondary) {
    buckets.push(
      windowBucket(snapshot.secondary, `${key}:secondary`, "长周期额度"),
    );
  }
  if (snapshot.individualLimit) {
    buckets.push({
      id: `${key}:individual`,
      label: "个人消费限额",
      remaining_percent: percent(snapshot.individualLimit.remainingPercent),
      used_percent: null,
      limit: null,
      used: null,
      remaining: null,
      resets_at: epochToIso(snapshot.individualLimit.resetsAt),
      unlimited: false,
      description:
        typeof snapshot.individualLimit.limit === "string"
          ? snapshot.individualLimit.limit
          : null,
    });
  }
  return buckets;
}

export function normalizeCodexQuota(
  value: unknown,
  now = new Date(),
): SyncedQuota {
  if (!isRecord(value)) {
    return unavailableQuota(now, "Codex 未返回额度数据");
  }
  const rateLimits = isRecord(value.rateLimits)
    ? (value.rateLimits as unknown as RateLimitSnapshot)
    : null;
  if (!rateLimits) {
    return unavailableQuota(now, "Codex 未返回额度数据");
  }

  const byLimitId = isRecord(value.rateLimitsByLimitId)
    ? (value.rateLimitsByLimitId as unknown as Record<string, RateLimitSnapshot>)
    : null;
  const buckets = snapshotToBuckets(rateLimits, "account");
  for (const [limitId, snapshot] of Object.entries(byLimitId ?? {})) {
    if (!isRecord(snapshot)) continue;
    const typed = snapshot as unknown as RateLimitSnapshot;
    if (limitId && limitId === rateLimits.limitId) continue;
    buckets.push(...snapshotToBuckets(typed, limitId || "account"));
  }

  const credits = isRecord(rateLimits.credits)
    ? rateLimits.credits
    : null;
  const resetCredits = isRecord(value.rateLimitResetCredits)
    ? value.rateLimitResetCredits
    : null;
  const availableResets = finiteNumber(resetCredits?.availableCount);
  return {
    provider: "codex",
    status: "ok",
    message: null,
    account: null,
    plan: typeof rateLimits.planType === "string" ? rateLimits.planType : null,
    fetched_at: now.toISOString(),
    buckets,
    credits: {
      balance:
        typeof credits?.balance === "string" ? credits.balance : null,
      has_credits: credits?.hasCredits === true,
      unlimited: credits?.unlimited === true,
      available_resets:
        availableResets !== null &&
          Number.isInteger(availableResets) &&
          availableResets >= 0
          ? availableResets
          : null,
      description: null,
    },
  };
}

export function unavailableQuota(
  now: Date,
  message: string,
): SyncedQuota {
  return {
    provider: "codex",
    status: "unavailable",
    message,
    account: null,
    plan: null,
    fetched_at: now.toISOString(),
    buckets: [],
    credits: null,
  };
}

export function quotaError(now: Date, message: string): SyncedQuota {
  return {
    provider: "codex",
    status: "error",
    message,
    account: null,
    plan: null,
    fetched_at: now.toISOString(),
    buckets: [],
    credits: null,
  };
}

import type { Json } from "@/lib/types/database";

export type ConnectionQuotaProvider = "codex" | "kimi" | "antigravity";
export type ConnectionQuotaStatus = "ok" | "unavailable" | "error";

export type ConnectionQuotaBucket = {
  id: string;
  label: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetsAt: string | null;
  unlimited: boolean;
  description: string | null;
};

export type ConnectionQuotaCredits = {
  balance: string | null;
  hasCredits: boolean;
  unlimited: boolean;
  availableResets: number | null;
  description: string | null;
};

export type ConnectionQuotaSnapshot = {
  provider: ConnectionQuotaProvider;
  status: ConnectionQuotaStatus;
  message: string | null;
  account: string | null;
  plan: string | null;
  fetchedAt: string;
  buckets: ConnectionQuotaBucket[];
  credits: ConnectionQuotaCredits | null;
};

function isRecord(
  value: unknown,
): value is { [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: { [key: string]: Json | undefined },
  key: string,
  maximum: number,
): string | null {
  const candidate = value[key];
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function numberField(
  value: { [key: string]: Json | undefined },
  key: string,
): number | null {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return null;
  return candidate;
}

function booleanField(
  value: { [key: string]: Json | undefined },
  key: string,
  fallback: boolean,
): boolean {
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : fallback;
}

function parseBucket(value: unknown): ConnectionQuotaBucket | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id", 200);
  const label = stringField(value, "label", 200);
  if (!id || !label) return null;
  const remainingPercent = numberField(value, "remaining_percent");
  const usedPercent = numberField(value, "used_percent");
  return {
    id,
    label,
    remainingPercent:
      remainingPercent !== null && remainingPercent >= 0 &&
        remainingPercent <= 100
        ? remainingPercent
        : null,
    usedPercent:
      usedPercent !== null && usedPercent >= 0 && usedPercent <= 100
        ? usedPercent
        : null,
    limit: numberField(value, "limit"),
    used: numberField(value, "used"),
    remaining: numberField(value, "remaining"),
    resetsAt: stringField(value, "resets_at", 100),
    unlimited: booleanField(value, "unlimited", false),
    description: stringField(value, "description", 2_000),
  };
}

function parseCredits(value: unknown): ConnectionQuotaCredits | null {
  if (!isRecord(value)) return null;
  const availableResets = numberField(value, "available_resets");
  return {
    balance: stringField(value, "balance", 200),
    hasCredits: booleanField(value, "has_credits", false),
    unlimited: booleanField(value, "unlimited", false),
    availableResets:
      availableResets !== null && Number.isInteger(availableResets) &&
        availableResets >= 0
        ? availableResets
        : null,
    description: stringField(value, "description", 2_000),
  };
}

/** Parse the Bridge-reported quota snapshot; malformed values return null. */
export function parseConnectionQuota(
  value: Json | null | undefined,
): ConnectionQuotaSnapshot | null {
  if (!isRecord(value)) return null;
  const provider = stringField(value, "provider", 50);
  if (
    provider !== "codex" &&
    provider !== "kimi" &&
    provider !== "antigravity"
  ) {
    return null;
  }
  const status = stringField(value, "status", 50);
  if (status !== "ok" && status !== "unavailable" && status !== "error") {
    return null;
  }
  const fetchedAt = stringField(value, "fetched_at", 100);
  if (!fetchedAt) return null;
  const rawBuckets = value.buckets;
  if (!Array.isArray(rawBuckets) || rawBuckets.length > 20) return null;
  const buckets = rawBuckets
    .map(parseBucket)
    .filter((bucket): bucket is ConnectionQuotaBucket => bucket !== null);
  if (buckets.length !== rawBuckets.length) return null;
  const rawCredits = value.credits;
  if (rawCredits !== null && rawCredits !== undefined) {
    const credits = parseCredits(rawCredits);
    if (!credits) return null;
    return {
      provider,
      status,
      message: stringField(value, "message", 2_000),
      account: stringField(value, "account", 200),
      plan: stringField(value, "plan", 200),
      fetchedAt,
      buckets,
      credits,
    };
  }
  return {
    provider,
    status,
    message: stringField(value, "message", 2_000),
    account: stringField(value, "account", 200),
    plan: stringField(value, "plan", 200),
    fetchedAt,
    buckets,
    credits: null,
  };
}

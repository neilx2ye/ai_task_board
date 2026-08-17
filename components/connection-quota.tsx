"use client";

import { ChevronDownIcon } from "lucide-react";

import {
  parseConnectionQuota,
  type ConnectionQuotaBucket,
  type ConnectionQuotaSnapshot,
} from "@/lib/domain/connection-quota";
import { formatDateTime, formatRelativeTime } from "@/components/utils";
import type { PublicConnection } from "@/hooks/use-connections";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/utils";

/** Compact quota summary shown on one Bridge card in the connections page. */
export function ConnectionQuota({ connection }: { connection: PublicConnection }) {
  const quota = parseConnectionQuota(connection.quota);
  if (!quota) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        额度未上报。升级对应 Bridge 后会自动显示套餐余量。
      </div>
    );
  }
  return <QuotaSnapshotView quota={quota} />;
}

function QuotaSnapshotView({ quota }: { quota: ConnectionQuotaSnapshot }) {
  if (quota.status === "error") {
    return (
      <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-900">
        额度获取失败：{quota.message || "请检查设备端登录状态"}
      </div>
    );
  }
  if (quota.status === "unavailable" || quota.buckets.length === 0) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
        {quota.message || "当前登录方式暂不提供额度数据"}
      </div>
    );
  }

  const primary = primaryBucket(quota.buckets);
  const plan = quota.plan || quota.account;
  return (
    <div className="rounded-md border border-border bg-muted/25 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">额度</span>
        <span
          className="text-[11px] text-muted-foreground"
          title={formatDateTime(quota.fetchedAt)}
        >
          {formatRelativeTime(quota.fetchedAt)}更新
        </span>
      </div>

      {plan ? (
        <div className="mt-1.5">
          <Badge
            variant="outline"
            className="h-5 gap-1 border-border px-1.5 py-0 text-[10px]"
          >
            {plan}
          </Badge>
        </div>
      ) : null}

      <div className="mt-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium">{primary.label}</span>
          <span className="shrink-0 tabular-nums">
            {primary.unlimited
              ? "不限量"
              : `${primary.remainingPercent?.toFixed(0) ?? "—"}%`}
          </span>
        </div>
        <QuotaBar
          remainingPercent={primary.remainingPercent}
          unlimited={primary.unlimited}
          className="mt-1"
        />
        {!primary.unlimited && primary.resetsAt ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            重置于 {formatRelativeTime(primary.resetsAt)}
          </p>
        ) : null}
      </div>

      {quota.credits ? <CreditsLine credits={quota.credits} /> : null}

      {quota.buckets.length > 1 ? (
        <details className="group mt-2 border-t border-border pt-1.5">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground outline-none">
            <span>查看 {quota.buckets.length} 个额度窗口</span>
            <ChevronDownIcon className="size-3 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {quota.buckets.map((bucket) => (
              <BucketRow key={bucket.id} bucket={bucket} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function BucketRow({ bucket }: { bucket: ConnectionQuotaBucket }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px]">
          {bucket.label}
          {bucket.description ? (
            <span className="text-muted-foreground"> · {bucket.description}</span>
          ) : null}
        </span>
        <span className="shrink-0 tabular-nums">
          {bucket.unlimited
            ? "不限量"
            : `${bucket.remainingPercent?.toFixed(0) ?? "—"}%`}
        </span>
      </div>
      <QuotaBar
        remainingPercent={bucket.remainingPercent}
        unlimited={bucket.unlimited}
        className="mt-0.5"
      />
      {!bucket.unlimited && bucket.resetsAt ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          重置于 {formatRelativeTime(bucket.resetsAt)}
        </p>
      ) : null}
    </div>
  );
}

function QuotaBar({
  remainingPercent,
  unlimited,
  className,
}: {
  remainingPercent: number | null;
  unlimited: boolean;
  className?: string;
}) {
  const percent = unlimited
    ? 100
    : remainingPercent === null
      ? 0
      : Math.min(100, Math.max(0, remainingPercent));
  const color =
    percent <= 10
      ? "bg-red-500"
      : percent <= 30
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label="剩余额度百分比"
    >
      <div
        className={cn("h-full rounded-full", color)}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function CreditsLine({
  credits,
}: {
  credits: NonNullable<ConnectionQuotaSnapshot["credits"]>;
}) {
  if (!credits.hasCredits && !credits.unlimited && !credits.availableResets) {
    return null;
  }
  const parts: string[] = [];
  if (credits.unlimited) parts.push("积分不限量");
  else if (credits.balance) parts.push(`积分 ${credits.balance}`);
  if (credits.availableResets) {
    parts.push(`${credits.availableResets} 次重置可用`);
  }
  if (!parts.length) return null;
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
      {parts.join(" · ")}
    </p>
  );
}

function primaryBucket(buckets: ConnectionQuotaBucket[]): ConnectionQuotaBucket {
  const known = buckets.filter(
    (bucket) => bucket.remainingPercent !== null && !bucket.unlimited,
  );
  if (known.length) {
    return known.reduce((left, right) =>
      (left.remainingPercent ?? 100) <= (right.remainingPercent ?? 100)
        ? left
        : right,
    );
  }
  return buckets[0];
}

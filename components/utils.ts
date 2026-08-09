import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const RELATIVE_UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.345, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

const relativeFormatter = new Intl.RelativeTimeFormat("zh-CN", {
  numeric: "auto",
});

/** 将 ISO 时间格式化为“x 分钟前”这类相对时间；无效输入返回占位符。 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "—";

  let value = (time - Date.now()) / 1000;
  for (const [amount, unit] of RELATIVE_UNITS) {
    if (Math.abs(value) < amount) {
      return relativeFormatter.format(Math.round(value), unit);
    }
    value /= amount;
  }
  return "—";
}

/** 将 ISO 时间格式化为本地完整时间，用于详情页与 title 提示。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatBytes(size: number | null | undefined): string {
  if (size == null || Number.isNaN(size)) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 判断 ISO 时间是否早于当前时刻（如租约已过期）。无效输入返回 false。 */
export function isPast(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return false;
  return time < Date.now();
}

import path from "node:path";

const SENSITIVE_FIELD_PATTERN =
  /(?:^|_)(?:api_key|authorization|credential|password|private_key|secret(?:_key)?|token)$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort failure text that keeps structured error payloads visible.
 *
 * Kimi ACP maps engine failures to a JSON-RPC internal error whose fixed
 * message is only "Internal error"; the actionable text travels in
 * `error.data.details`. Board-facing reasons should use this helper instead
 * of `errorMessage` so those details are not silently discarded.
 */
export function errorDescription(error: unknown): string {
  const message = errorMessage(error);
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "string" && data.trim()) {
    return `${message}：${data}`;
  }
  if (!isRecord(data)) return message;
  const details = data.details;
  if (typeof details === "string" && details.trim()) {
    return `${message}：${details}`;
  }
  try {
    const serialized = JSON.stringify(data);
    if (serialized && serialized !== "{}" && serialized !== "null") {
      return `${message}：${serialized}`;
    }
  } catch {
    // 无法序列化的 data 直接忽略，保留原始 message。
  }
  return message;
}

export function errorStatus(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

export function isPersistentClientError(error: unknown): boolean {
  const status = errorStatus(error);
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function redactText(value: string, limit = 100_000): string {
  const redacted = value
    .replace(
      /\b(?:sk[-_][A-Za-z0-9_-]{12,}|atb_[A-Za-z0-9_-]{12,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /(authorization\s*[:=]\s*bearer\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b["']?(?:access[_-]?token|api[_-]?key|credential|password|private[_-]?key|secret(?:[_-]?key)?|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    );
  if (redacted.length <= limit) return redacted;
  const suffix = "\n…[已截断；完整输出请作为附件上传]";
  return `${redacted.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[截断：嵌套过深]";
  if (typeof value === "string") return redactText(value, 20_000);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          key,
          SENSITIVE_FIELD_PATTERN.test(
            key
              .replace(/([a-z\d])([A-Z])/g, "$1_$2")
              .replace(/[-\s]+/g, "_")
              .toLowerCase(),
          )
            ? "[REDACTED]"
            : sanitizeValue(item, depth + 1),
        ]),
    );
  }
  return value;
}

export function appendBoundedText(
  current: string,
  addition: string,
  limit = 100_000,
): string {
  if (!addition || current.length >= limit) return current;
  let end = Math.min(addition.length, limit - current.length);
  if (
    end > 0 &&
    end < addition.length &&
    /[\uD800-\uDBFF]/.test(addition[end - 1] ?? "")
  ) {
    end -= 1;
  }
  return current + addition.slice(0, end);
}

export function exactPath(candidate: string, configured: string): boolean {
  return path.relative(path.resolve(configured), path.resolve(candidate)) === "";
}

export function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`数值必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return parsed;
}

export function parseBoolean(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  throw new Error("布尔值必须是 true 或 false");
}

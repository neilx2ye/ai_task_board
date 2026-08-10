const MAX_ACTIVITY_DATA_BYTES = 240 * 1024;
const SENSITIVE_FIELD_PATTERN =
  /(?:^|_)(?:api_key|authorization|credential|password|private_key|secret(?:_key)?|token)$/;

function isSensitiveField(key: string): boolean {
  const normalized = key
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return SENSITIVE_FIELD_PATTERN.test(normalized);
}

/** Best-effort redaction before Harness output crosses into the shared Board. */
export function redactHarnessText(value: string, limit = 20_000): string {
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
      /(\b["']?(?:access[_-]?token|api[_-]?key|bearer[_-]?token|credential|password|private[_-]?key|secret(?:[_-]?key)?|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    );
  if (redacted.length <= limit) return redacted;
  const suffix = "\n…[已截断；完整输出请作为附件上传]";
  if (limit <= suffix.length) return redacted.slice(0, limit);
  return `${redacted.slice(0, limit - suffix.length)}${suffix}`;
}

export function sanitizeHarnessValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[截断：嵌套过深]";
  if (typeof value === "string") return redactHarnessText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeHarnessValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
    return Object.fromEntries(
      entries.map(([key, item]) => [
        key,
        isSensitiveField(key)
          ? "[REDACTED]"
          : sanitizeHarnessValue(item, depth + 1),
      ]),
    );
  }
  return value;
}

export function boundActivityData(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = sanitizeHarnessValue(value) as Record<string, unknown>;
  const encoded = JSON.stringify(sanitized);
  if (new TextEncoder().encode(encoded).byteLength <= MAX_ACTIVITY_DATA_BYTES) {
    return sanitized;
  }
  return {
    truncated: true,
    // 60k UTF-16 code units stay below the API's 256 KiB limit even if every
    // character requires four UTF-8 bytes.
    preview: redactHarnessText(encoded, 60_000),
  };
}

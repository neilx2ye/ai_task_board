import type { Json } from "@/lib/types/database";

/**
 * Codex App Server 活动流在 data 里携带的协议信封字段。它们只对流式归并
 * （components/session-activity-stream.ts）有意义，直接展示给用户只是噪音。
 */
const ACTIVITY_ENVELOPE_KEYS = new Set([
  "protocol",
  "phase",
  "turn_ref",
  "item_ref",
  "chunk_index",
  "disclosure",
  "phase_name",
]);

function isJsonObject(
  value: unknown,
): value is { [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 剥离活动 data 里的协议信封字段，返回真正值得展示的剩余字段；
 * 剥离后没有内容（或 data 本身不是非空对象）时返回 null，调用方应隐藏详情区。
 */
export function activityDetailsData(data: Json): Json | null {
  if (!isJsonObject(data)) return data === null ? null : data;
  const rest = Object.fromEntries(
    Object.entries(data).filter(([key]) => !ACTIVITY_ENVELOPE_KEYS.has(key)),
  );
  return Object.keys(rest).length > 0 ? rest : null;
}

export type TokenUsageSummary = {
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  total: number | null;
  contextWindow: number | null;
};

function numberField(
  source: { [key: string]: Json | undefined },
  ...aliases: readonly string[]
): number | null {
  for (const alias of aliases) {
    const value = source[alias];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * 容错解析 usage 活动的 token 用量。Bridge 透传的是 Codex App Server
 * `thread/tokenUsage/updated` 的 payload，字段可能是 camelCase 或 snake_case，
 * 累计值通常在 `total` 子对象里。找不到任何已知字段时返回 null。
 */
export function summarizeTokenUsage(data: Json): TokenUsageSummary | null {
  if (!isJsonObject(data)) return null;
  const usage = data.usage;
  if (!isJsonObject(usage)) return null;

  const bucket = isJsonObject(usage.total) ? usage.total : usage;
  const summary: TokenUsageSummary = {
    input: numberField(bucket, "inputTokens", "input_tokens"),
    cachedInput: numberField(
      bucket,
      "cachedInputTokens",
      "cached_input_tokens",
      "cachedInput",
    ),
    output: numberField(bucket, "outputTokens", "output_tokens"),
    reasoningOutput: numberField(
      bucket,
      "reasoningOutputTokens",
      "reasoning_output_tokens",
    ),
    total: numberField(bucket, "totalTokens", "total_tokens"),
    contextWindow: numberField(
      usage,
      "modelContextWindow",
      "model_context_window",
    ),
  };

  return Object.values(summary).some((value) => value !== null)
    ? summary
    : null;
}

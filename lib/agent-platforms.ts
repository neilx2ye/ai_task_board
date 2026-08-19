/** Unified device connection platform: one token hosts every Bridge runtime. */
export const UNIFIED_CONNECTION_PLATFORM = "All";

/** Canonical Bridge kinds stored on platform-scoped settings rows. */
export const BRIDGE_KINDS = [
  "codex",
  "kimi",
  "antigravity",
  "claude",
] as const;

export type BridgeKind = (typeof BRIDGE_KINDS)[number];

export function isUnifiedPlatform(
  platform: string | null | undefined,
): boolean {
  const value = platform?.trim().toLowerCase() ?? "";
  return value === "all" || value === "unified" || value === "统一设备 bridge";
}

/**
 * Map connection display platforms, session platforms and runtime kinds onto
 * the canonical settings-row key. Unknown values are lower-cased rather than
 * guessed, so a future Bridge kind keeps a stable, distinct row.
 */
export function canonicalBridgeKind(
  platform: string | null | undefined,
): string {
  const value = platform?.trim().toLowerCase() ?? "";
  if (!value || value === "all" || value === "unified") return "codex";
  if (value.includes("kimi")) return "kimi";
  if (value.includes("antigravity")) return "antigravity";
  if (value.includes("claude")) return "claude";
  if (value.includes("codex")) return "codex";
  return value;
}

export function isBridgeKind(value: string): value is BridgeKind {
  return (BRIDGE_KINDS as readonly string[]).includes(value);
}

export function bridgeKindDisplayName(kind: string | null | undefined): string {
  if (kind === "kimi") return "Kimi Code";
  if (kind === "antigravity") return "Antigravity";
  if (kind === "claude") return "Claude Code";
  if (kind === "codex") return "Codex";
  return kind?.trim() || "Agent";
}

export function connectionPlatformLabel(
  platform: string | null | undefined,
): string {
  if (isUnifiedPlatform(platform)) return "统一设备 Bridge";
  return agentDisplayName(platform);
}

export function isKimiPlatform(platform: string | null | undefined): boolean {
  return platform?.toLowerCase().includes("kimi") === true;
}

export function isAntigravityPlatform(
  platform: string | null | undefined,
): boolean {
  return platform?.toLowerCase().includes("antigravity") === true;
}

export function isClaudeCodePlatform(
  platform: string | null | undefined,
): boolean {
  return platform?.toLowerCase().includes("claude") === true;
}

export function agentDisplayName(platform: string | null | undefined): string {
  if (isKimiPlatform(platform)) return "Kimi Code";
  if (isAntigravityPlatform(platform)) return "Antigravity";
  if (isClaudeCodePlatform(platform)) return "Claude Code";
  if (platform?.toLowerCase().includes("codex")) return "Codex";
  return platform?.trim() || "Agent";
}

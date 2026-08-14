export function isKimiPlatform(platform: string | null | undefined): boolean {
  return platform?.toLowerCase().includes("kimi") === true;
}

export function agentDisplayName(platform: string | null | undefined): string {
  if (isKimiPlatform(platform)) return "Kimi Code";
  if (platform?.toLowerCase().includes("codex")) return "Codex";
  return platform?.trim() || "Agent";
}

export type ReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type CodexModelOption = {
  value: string;
  label: string;
  description: string;
  efforts: readonly ReasoningEffort[];
};

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT: ReasoningEffort = "max";

export const CODEX_MODEL_OPTIONS: readonly CodexModelOption[] = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description: "旗舰能力，适合复杂编码与长任务",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    description: "能力、速度与用量的均衡选择",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "更快，适合高频和较轻量任务",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    description: "上一代通用旗舰模型",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    value: "gpt-5.4",
    label: "GPT-5.4",
    description: "通用编码模型",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    value: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "更轻量的通用模型",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    value: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    description: "快速、聚焦的编码任务",
    efforts: ["low", "medium", "high", "xhigh"],
  },
];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Low · 快速",
  medium: "Medium · 均衡",
  high: "High · 深入",
  xhigh: "Extra High · 更深入",
  max: "Max · 最大",
  ultra: "Ultra · 最高",
};

export function codexModelOption(model: string): CodexModelOption | undefined {
  return CODEX_MODEL_OPTIONS.find((option) => option.value === model);
}

export function compatibleReasoningEffort(
  model: string,
  preferred: string | null | undefined,
): ReasoningEffort {
  const efforts = codexModelOption(model)?.efforts;
  if (!efforts?.length) {
    return (preferred as ReasoningEffort | undefined) ??
      DEFAULT_CODEX_REASONING_EFFORT;
  }
  if (preferred && efforts.includes(preferred as ReasoningEffort)) {
    return preferred as ReasoningEffort;
  }
  if (efforts.includes(DEFAULT_CODEX_REASONING_EFFORT)) {
    return DEFAULT_CODEX_REASONING_EFFORT;
  }
  return efforts.at(-1) ?? "medium";
}

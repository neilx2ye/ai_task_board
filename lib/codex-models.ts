export type ReasoningEffort = string;

export type CodexModelCatalogEffort = {
  reasoning_effort: string;
  description: string | null;
};

export type CodexModelCatalogEntry = {
  id: string;
  model: string;
  display_name: string;
  description: string | null;
  default_reasoning_effort: string | null;
  supported_reasoning_efforts: readonly CodexModelCatalogEffort[];
  input_modalities: readonly string[];
  is_default: boolean;
};

export type CodexModelOption = {
  value: string;
  label: string;
  description: string;
  efforts: readonly ReasoningEffort[];
  defaultEffort: ReasoningEffort | null;
  effortDescriptions: Readonly<Record<string, string>>;
  isDefault: boolean;
};

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT: ReasoningEffort = "max";

export const CODEX_MODEL_OPTIONS: readonly CodexModelOption[] = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description: "旗舰能力，适合复杂编码与长任务",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "max",
    effortDescriptions: {},
    isDefault: true,
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    description: "能力、速度与用量的均衡选择",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "max",
    effortDescriptions: {},
    isDefault: false,
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "更快，适合高频和较轻量任务",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "max",
    effortDescriptions: {},
    isDefault: false,
  },
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    description: "上一代通用旗舰模型",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    effortDescriptions: {},
    isDefault: false,
  },
  {
    value: "gpt-5.4",
    label: "GPT-5.4",
    description: "通用编码模型",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    effortDescriptions: {},
    isDefault: false,
  },
  {
    value: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "更轻量的通用模型",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    effortDescriptions: {},
    isDefault: false,
  },
  {
    value: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    description: "快速、聚焦的编码任务",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    effortDescriptions: {},
    isDefault: false,
  },
];

export const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low · 快速",
  medium: "Medium · 均衡",
  high: "High · 深入",
  xhigh: "Extra High · 更深入",
  max: "Max · 最大",
  ultra: "Ultra · 最高",
};

function catalogRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCodexModelCatalog(
  value: unknown,
): CodexModelCatalogEntry[] | null {
  if (!Array.isArray(value)) return null;
  const models = new Set<string>();
  const parsed: CodexModelCatalogEntry[] = [];
  for (const candidate of value.slice(0, 500)) {
    if (!catalogRecord(candidate)) continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const model =
      typeof candidate.model === "string" ? candidate.model.trim() : "";
    const displayName =
      typeof candidate.display_name === "string"
        ? candidate.display_name.trim()
        : "";
    if (!id || !model || !displayName || models.has(model)) continue;
    const efforts = Array.isArray(candidate.supported_reasoning_efforts)
      ? candidate.supported_reasoning_efforts.flatMap((effort) => {
          if (!catalogRecord(effort)) return [];
          const reasoningEffort =
            typeof effort.reasoning_effort === "string"
              ? effort.reasoning_effort.trim()
              : "";
          if (!reasoningEffort) return [];
          return [{
            reasoning_effort: reasoningEffort,
            description:
              typeof effort.description === "string"
                ? effort.description
                : null,
          }];
        })
      : [];
    const inputModalities = Array.isArray(candidate.input_modalities)
      ? candidate.input_modalities.filter(
          (modality): modality is string =>
            typeof modality === "string" && Boolean(modality.trim()),
        )
      : [];
    models.add(model);
    parsed.push({
      id,
      model,
      display_name: displayName,
      description:
        typeof candidate.description === "string"
          ? candidate.description
          : null,
      default_reasoning_effort:
        typeof candidate.default_reasoning_effort === "string"
          ? candidate.default_reasoning_effort
          : null,
      supported_reasoning_efforts: efforts,
      input_modalities: inputModalities,
      is_default: candidate.is_default === true,
    });
  }
  return parsed;
}

export function codexModelOptions(
  catalog: readonly CodexModelCatalogEntry[] | null | undefined,
): readonly CodexModelOption[] {
  if (!catalog?.length) return CODEX_MODEL_OPTIONS;
  return catalog.map((entry) => ({
    value: entry.model,
    label: entry.display_name || entry.model,
    description:
      entry.description || "由当前 Codex App Server 提供的模型。",
    efforts: entry.supported_reasoning_efforts.map(
      (effort) => effort.reasoning_effort,
    ),
    defaultEffort: entry.default_reasoning_effort,
    effortDescriptions: Object.fromEntries(
      entry.supported_reasoning_efforts.flatMap((effort) =>
        effort.description
          ? [[effort.reasoning_effort, effort.description] as const]
          : [],
      ),
    ),
    isDefault: entry.is_default,
  }));
}

export function defaultCodexModel(
  options: readonly CodexModelOption[] = CODEX_MODEL_OPTIONS,
): string {
  return options.find((option) => option.isDefault)?.value ??
    options.find((option) => option.value === DEFAULT_CODEX_MODEL)?.value ??
    options[0]?.value ??
    DEFAULT_CODEX_MODEL;
}

export function codexModelOption(
  model: string,
  options: readonly CodexModelOption[] = CODEX_MODEL_OPTIONS,
): CodexModelOption | undefined {
  return options.find((option) => option.value === model);
}

export function compatibleReasoningEffort(
  model: string,
  preferred: string | null | undefined,
  options: readonly CodexModelOption[] = CODEX_MODEL_OPTIONS,
): ReasoningEffort {
  const selected = codexModelOption(model, options);
  const efforts = selected?.efforts;
  if (!efforts?.length) {
    return preferred ?? selected?.defaultEffort ??
      DEFAULT_CODEX_REASONING_EFFORT;
  }
  if (preferred && efforts.includes(preferred)) {
    return preferred;
  }
  const modelDefaultEffort = selected?.defaultEffort;
  if (modelDefaultEffort && efforts.includes(modelDefaultEffort)) {
    return modelDefaultEffort;
  }
  if (efforts.includes(DEFAULT_CODEX_REASONING_EFFORT)) {
    return DEFAULT_CODEX_REASONING_EFFORT;
  }
  return efforts.at(-1) ?? "medium";
}

export function reasoningEffortLabel(
  effort: string,
  description?: string | null,
): string {
  return REASONING_EFFORT_LABELS[effort] ?? description ?? effort;
}

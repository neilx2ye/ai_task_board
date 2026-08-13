import { describe, expect, it } from "vitest";

import {
  codexModelOptions,
  compatibleReasoningEffort,
  defaultCodexModel,
  parseCodexModelCatalog,
  reasoningEffortLabel,
} from "@/lib/codex-models";

describe("Codex model catalog", () => {
  it("uses the App Server catalog and its provider-specific effort names", () => {
    const catalog = parseCodexModelCatalog([{
      id: "custom-fast",
      model: "provider/custom-fast",
      display_name: "Custom Fast",
      description: "Private provider model",
      default_reasoning_effort: "balanced",
      supported_reasoning_efforts: [
        { reasoning_effort: "quick", description: "Faster response" },
        { reasoning_effort: "balanced", description: "More analysis" },
      ],
      input_modalities: ["text"],
      is_default: true,
    }]);
    const options = codexModelOptions(catalog);

    expect(options.map((option) => option.value)).toEqual([
      "provider/custom-fast",
    ]);
    expect(defaultCodexModel(options)).toBe("provider/custom-fast");
    expect(
      compatibleReasoningEffort(
        "provider/custom-fast",
        "unsupported",
        options,
      ),
    ).toBe("balanced");
    expect(reasoningEffortLabel("quick", "Faster response")).toBe(
      "Faster response",
    );
  });

  it("falls back to the compatibility catalog when none was reported", () => {
    const options = codexModelOptions(null);

    expect(options.length).toBeGreaterThan(1);
    expect(defaultCodexModel(options)).toBe("gpt-5.6-sol");
  });
});

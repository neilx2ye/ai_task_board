import { describe, expect, it } from "vitest";

import {
  activityDetailsData,
  summarizeTokenUsage,
} from "@/components/session-activity-present";

describe("activityDetailsData", () => {
  it("returns null when data only carries the app-server envelope", () => {
    expect(
      activityDetailsData({
        protocol: "codex-app-server/v1",
        phase: "completed",
        turn_ref: "turn-1",
        item_ref: "item-1",
        chunk_index: 0,
        disclosure: "provider_summary",
        phase_name: "explore",
      }),
    ).toBeNull();
  });

  it("keeps meaningful fields while stripping the envelope", () => {
    expect(
      activityDetailsData({
        protocol: "codex-app-server/v1",
        phase: "completed",
        turn_ref: "turn-1",
        item_ref: "item-1",
        exit_code: 0,
        files: ["a.ts"],
      }),
    ).toEqual({ exit_code: 0, files: ["a.ts"] });
  });

  it("returns null for empty objects and null data", () => {
    expect(activityDetailsData({})).toBeNull();
    expect(activityDetailsData(null)).toBeNull();
  });

  it("passes scalar data through untouched", () => {
    expect(activityDetailsData("plain note")).toBe("plain note");
    expect(activityDetailsData(42)).toBe(42);
  });

  it("does not strip envelope-named keys inside nested objects", () => {
    expect(
      activityDetailsData({
        protocol: "codex-app-server/v1",
        usage: { totalTokens: 10, phase: "kept" },
      }),
    ).toEqual({ usage: { totalTokens: 10, phase: "kept" } });
  });
});

describe("summarizeTokenUsage", () => {
  it("parses the nested total bucket with camelCase fields", () => {
    expect(
      summarizeTokenUsage({
        protocol: "codex-app-server/v1",
        phase: "completed",
        usage: {
          total: {
            totalTokens: 9000,
            inputTokens: 7000,
            cachedInputTokens: 2000,
            outputTokens: 2000,
            reasoningOutputTokens: 500,
          },
          modelContextWindow: 272000,
        },
      }),
    ).toEqual({
      input: 7000,
      cachedInput: 2000,
      output: 2000,
      reasoningOutput: 500,
      total: 9000,
      contextWindow: 272000,
    });
  });

  it("accepts snake_case fields at the top level of usage", () => {
    expect(
      summarizeTokenUsage({
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          model_context_window: 128000,
        },
      }),
    ).toEqual({
      input: 12,
      cachedInput: null,
      output: 5,
      reasoningOutput: null,
      total: 17,
      contextWindow: 128000,
    });
  });

  it("returns null when no known field exists", () => {
    expect(summarizeTokenUsage({ usage: { something: "else" } })).toBeNull();
    expect(summarizeTokenUsage({ usage: null })).toBeNull();
    expect(summarizeTokenUsage({})).toBeNull();
    expect(summarizeTokenUsage(null)).toBeNull();
  });

  it("ignores non-numeric values but keeps the ones that parse", () => {
    expect(
      summarizeTokenUsage({
        usage: { inputTokens: "many", outputTokens: 3 },
      }),
    ).toEqual({
      input: null,
      cachedInput: null,
      output: 3,
      reasoningOutput: null,
      total: null,
      contextWindow: null,
    });
  });
});

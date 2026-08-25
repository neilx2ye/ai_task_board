import { describe, expect, it } from "vitest";

import { clampConversationPanelWidth } from "@/components/resizable-session-panel";

describe("resizable conversation panels", () => {
  it("keeps each panel inside practical viewport bounds", () => {
    expect(clampConversationPanelWidth(640, 1_280)).toBe(640);
    expect(clampConversationPanelWidth(120, 1_280)).toBe(320);
    expect(clampConversationPanelWidth(2_000, 1_280)).toBe(1_248);
    expect(clampConversationPanelWidth(640, 300)).toBe(268);
  });
});

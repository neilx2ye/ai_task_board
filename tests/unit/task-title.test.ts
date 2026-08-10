import { describe, expect, it } from "vitest";

import { taskTitleFromPrompt } from "@/lib/domain/task-title";

describe("taskTitleFromPrompt", () => {
  it("uses the first non-empty sentence and removes a Markdown heading", () => {
    expect(
      taskTitleFromPrompt("\n  ## 修复登录回调。 后面是补充说明\n更多内容"),
    ).toBe("修复登录回调。");
  });

  it("normalizes whitespace and truncates by Unicode code point", () => {
    const title = taskTitleFromPrompt(`  ${"界".repeat(100)}  `);
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("has a defensive fallback for blank input", () => {
    expect(taskTitleFromPrompt(" \n\t ")).toBe("新任务");
  });
});

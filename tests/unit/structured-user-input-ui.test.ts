import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  StructuredUserInputForm,
} from "@/components/structured-user-input-form";
import type { TaskUserInputRequestRow } from "@/lib/types/database";

function requestFixture(): TaskUserInputRequestRow {
  return {
    id: "req-1",
    workspace_id: "ws-1",
    task_id: "task-1",
    session_id: "session-1",
    message_id: "msg-1",
    external_request_id: "external-1",
    turn_id: "turn-1",
    item_id: "item-1",
    is_blocking: true,
    status: "pending",
    questions: [
      {
        id: "q1",
        header: "实施方向",
        question: "你想采用哪种实现方式？",
        options: [
          { label: "方案 A：纯前端改造", description: "改动最小、交付最快" },
          { label: "方案 B：全栈改造", description: "扩展性更好" },
        ],
        isOther: true,
        isSecret: false,
      },
    ],
    answered_at: null,
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
  };
}

function render(element: ReactElement) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      element,
    ),
  );
}

describe("structured user input UI", () => {
  it("renders implementation options as selectable radio choices", () => {
    const markup = render(
      createElement(StructuredUserInputForm, {
        request: requestFixture(),
      }),
    );

    expect(markup).toContain('type="radio"');
    expect(markup).toContain("方案 A：纯前端改造");
    expect(markup).toContain("改动最小、交付最快");
    expect(markup).toContain("方案 B：全栈改造");
    expect(markup).toContain("扩展性更好");
    expect(markup).toContain("其他");
    expect(markup).toContain("提交并继续原 turn");
  });

  it("can hide the inline intro when embedded in a popup", () => {
    const markup = render(
      createElement(StructuredUserInputForm, {
        request: requestFixture(),
        hideIntro: true,
      }),
    );

    expect(markup).not.toContain("AI 正在当前 turn 中等待选择");
    expect(markup).toContain("你想采用哪种实现方式？");
  });
});

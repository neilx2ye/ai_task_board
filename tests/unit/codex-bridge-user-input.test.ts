import { describe, expect, it } from "vitest";

import {
  parseStructuredUserInputAnswers,
  parseStructuredUserInputRequest,
} from "../../packages/codex-bridge/src/bridge";

describe("Codex Bridge structured user input", () => {
  it("normalizes App Server questions and builds the exact response envelope", () => {
    const request = parseStructuredUserInputRequest({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      isBlocking: true,
      questions: [
        {
          id: "deploy",
          header: "发布",
          question: "选择发布方式",
          options: [{ label: "滚动", description: "逐步替换" }],
          isOther: true,
        },
      ],
    });

    expect(request.questions[0]).toMatchObject({
      id: "deploy",
      isOther: true,
      isSecret: false,
    });
    expect(
      parseStructuredUserInputAnswers(
        { deploy: ["滚动"] },
        request.questions,
      ),
    ).toEqual({ deploy: { answers: ["滚动"] } });
  });

  it("rejects non-blocking prompts and incomplete Web answers", () => {
    expect(() =>
      parseStructuredUserInputRequest({
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: false,
        questions: [],
      }),
    ).toThrow(/blocking/);

    const request = parseStructuredUserInputRequest({
      turnId: "turn-1",
      itemId: "item-1",
      isBlocking: true,
      questions: [
        { id: "one", header: "一", question: "第一题", options: null },
        { id: "two", header: "二", question: "第二题", options: null },
      ],
    });
    expect(() =>
      parseStructuredUserInputAnswers({ one: ["回答"] }, request.questions),
    ).toThrow(/two/);
  });
});

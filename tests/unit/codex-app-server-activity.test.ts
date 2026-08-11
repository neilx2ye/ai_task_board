import { describe, expect, it } from "vitest";

import {
  acceptBoundedStreamDelta,
  appendBoundedPrefix,
  completedItemActivity,
  startedItemActivity,
  utf8DeltaChunks,
} from "../../packages/codex-bridge/src/bridge";

describe("Codex App Server activity mapping", () => {
  it("publishes provider reasoning summaries without raw reasoning content", () => {
    const activity = completedItemActivity(
      {
        type: "reasoning",
        id: "item-reasoning",
        summary: ["Checked the implementation", "Found the race"],
        content: ["hidden raw model reasoning"],
      },
      "turn-1",
      null,
    );

    expect(activity).toEqual({
      kind: "reasoning",
      content: "Checked the implementation\n\nFound the race",
      data: {
        protocol: "codex-app-server/v1",
        phase: "completed",
        turn_ref: "turn-1",
        item_ref: "item-reasoning",
        disclosure: "provider_summary",
      },
    });
    expect(JSON.stringify(activity)).not.toContain("hidden raw model reasoning");
  });

  it("marks streamed assistant completion as the authoritative item", () => {
    const activity = completedItemActivity(
      {
        type: "agentMessage",
        id: "item-message",
        text: "Finished",
        phase: "final_answer",
      },
      "turn-2",
      "partial",
    );

    expect(activity?.kind).toBe("assistant_message");
    expect(activity?.content).toBe("Finished");
    expect(activity?.data).toMatchObject({
      protocol: "codex-app-server/v1",
      phase: "completed",
      turn_ref: "turn-2",
      item_ref: "item-message",
    });
  });

  it("reports command start and sanitizes completed output", () => {
    const started = startedItemActivity(
      {
        type: "commandExecution",
        id: "item-command",
        command: "npm test",
        cwd: "/workspace",
        status: "inProgress",
      },
      "turn-3",
    );
    const completed = completedItemActivity(
      {
        type: "commandExecution",
        id: "item-command",
        command: "npm test",
        cwd: "/workspace",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "api_key=sk-test_abcdefghijklmnop",
      },
      "turn-3",
      null,
    );

    expect(started?.data).toMatchObject({ phase: "started" });
    expect(completed?.data).toMatchObject({
      phase: "completed",
      exit_code: 0,
      output: "api_key=[REDACTED]",
    });
  });

  it("does not duplicate the user message already stored by the Board", () => {
    expect(
      completedItemActivity(
        { type: "userMessage", id: "item-user", content: [] },
        "turn-4",
        null,
      ),
    ).toBeNull();
  });

  it("uses the complete streamed text when completion omits authoritative content", () => {
    const reasoning = completedItemActivity(
      { type: "reasoning", id: "reasoning-stream", summary: [] },
      "turn-stream",
      "first half second half",
    );
    const command = completedItemActivity(
      {
        type: "commandExecution",
        id: "command-stream",
        command: "generate output",
        aggregatedOutput: "",
      },
      "turn-stream",
      "line one\nline two",
    );

    expect(reasoning?.content).toBe("first half second half");
    expect(command?.data).toMatchObject({ output: "line one\nline two" });
  });

  it("omits reasoning items when the provider exposed no readable summary", () => {
    expect(
      completedItemActivity(
        {
          type: "reasoning",
          id: "reasoning-empty",
          summary: ["  "],
          content: ["hidden raw model reasoning"],
        },
        "turn-empty",
        null,
      ),
    ).toBeNull();
  });

  it("chunks large UTF-8 deltas before buffering and bounds accumulated text", () => {
    const source = `${"界".repeat(5_000)} ${"x".repeat(20_000)}`;
    const chunks = [...utf8DeltaChunks(source)];

    expect(chunks.join("")).toBe(source);
    expect(
      chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 8_192),
    ).toBe(true);
    expect(appendBoundedPrefix("a".repeat(99_999), "😀tail")).toBe(
      "a".repeat(99_999),
    );
    expect(appendBoundedPrefix("", "z".repeat(150_000))).toHaveLength(100_000);
    const bounded = acceptBoundedStreamDelta("", "z".repeat(2_000_000));
    expect(bounded.truncated).toBe(true);
    expect(bounded.accepted).toHaveLength(100_000);
    expect(bounded.accepted).toContain("[流式输出已截断]");
    expect(bounded.accumulated).toBe(bounded.accepted);
  });
});

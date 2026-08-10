import { describe, expect, it, vi } from "vitest";

import { createPendingIdempotencyTracker } from "@/hooks/pending-idempotency";

describe("pending request idempotency", () => {
  it("deduplicates commit-then-response-loss and consecutive retries", async () => {
    const generated = ["key-1", "key-2", "key-3"];
    const tracker = createPendingIdempotencyTracker(() => generated.shift()!);
    const committed = new Set<string>();
    const attempts: string[] = [];

    const send = async (content: string, loseResponse: boolean) => {
      const key = tracker.keyFor(content);
      attempts.push(key);
      // The server commits before the simulated connection drops. Replaying
      // this key therefore returns the same logical mutation.
      committed.add(key);
      if (loseResponse) throw new Error("response lost");
      tracker.confirm(content, key);
    };

    await expect(send("session-1\0hello", true)).rejects.toThrow(
      "response lost",
    );
    await expect(send("session-1\0hello", true)).rejects.toThrow(
      "response lost",
    );
    await send("session-1\0hello", false);

    expect(attempts).toEqual(["key-1", "key-1", "key-1"]);
    expect(committed).toEqual(new Set(["key-1"]));

    // A confirmed request with identical text is a new turn.
    expect(tracker.keyFor("session-1\0hello")).toBe("key-2");
  });

  it("rotates immediately when the user explicitly changes the content", () => {
    const generate = vi
      .fn<() => string>()
      .mockReturnValueOnce("key-1")
      .mockReturnValueOnce("key-2");
    const tracker = createPendingIdempotencyTracker(generate);

    expect(tracker.keyFor("session-1\0first")).toBe("key-1");
    expect(tracker.keyFor("session-1\0second")).toBe("key-2");
    expect(tracker.keyFor("session-1\0second")).toBe("key-2");
  });
});

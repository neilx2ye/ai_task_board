import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/hooks/api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch idempotency", () => {
  it("uses a caller-provided idempotency key for a retryable write", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/user/sessions/session-1/turns", {
      method: "POST",
      json: { content: "hello" },
      idempotencyKey: "session-turn/retry-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user/sessions/session-1/turns",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": "session-turn/retry-1",
        }),
      }),
    );
  });
});

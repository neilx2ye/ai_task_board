import { describe, expect, it, vi } from "vitest";

import { KimiWebGoalClient } from "../../packages/kimi-bridge/src/web-goal-client";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Kimi web Goal client", () => {
  it("creates a goal through the session profile endpoint", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ code: 0, msg: "success", data: {} });
    });
    const client = new KimiWebGoalClient({
      baseUrl: "http://127.0.0.1:58627",
      token: "secret",
      fetch,
    });

    await client.setGoal("session_abc", "  修复所有失败的测试  ");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://127.0.0.1:58627/api/v1/sessions/session_abc/profile",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(
      JSON.stringify({ agent_config: { goal_objective: "修复所有失败的测试" } }),
    );
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(
      "Bearer secret",
    );
  });

  it("cancels a goal and tolerates an absent goal", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 40001, msg: "goal.not_found" }),
      );
    const client = new KimiWebGoalClient({
      baseUrl: "http://127.0.0.1:58627",
      fetch,
    });

    await expect(client.cancelGoal("session_abc")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("surfaces a rejected goal operation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 40002, msg: "goal.objective_too_long" }),
      );
    const client = new KimiWebGoalClient({
      baseUrl: "http://127.0.0.1:58627",
      fetch,
    });

    await expect(client.setGoal("session_abc", "goal")).rejects.toThrow(
      "goal.objective_too_long",
    );
  });

  it("rejects an over-long objective before sending it", async () => {
    const fetch = vi.fn();
    const client = new KimiWebGoalClient({
      baseUrl: "http://127.0.0.1:58627",
      fetch,
    });

    await expect(
      client.setGoal("session_abc", "长".repeat(4_001)),
    ).rejects.toThrow("4000");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads the current goal snapshot", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        code: 0,
        msg: "success",
        data: {
          goalId: "goal-1",
          objective: "修好构建",
          status: "active",
          turnsUsed: 2,
          tokensUsed: 100,
          wallClockMs: 1_000,
          budget: {},
        },
      }),
    );
    const client = new KimiWebGoalClient({
      baseUrl: "http://127.0.0.1:58627",
      fetch,
    });

    await expect(client.getGoal("session_abc")).resolves.toEqual({
      goalId: "goal-1",
      objective: "修好构建",
      status: "active",
    });
  });

  it("reads a null goal snapshot", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ code: 0, msg: "success", data: null }),
    );
    const client = new KimiWebGoalClient({
      baseUrl: "http://127.0.0.1:58627",
      fetch,
    });

    await expect(client.getGoal("session_abc")).resolves.toBeNull();
  });
});

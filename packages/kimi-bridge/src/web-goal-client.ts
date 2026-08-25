import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isRecord, stringValue } from "./utils.js";

const GOAL_OBJECTIVE_LIMIT = 4_000;
const DEFAULT_SERVER_DIR = ".kimi-code/server";

export type KimiGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "complete";

export type KimiGoalSnapshot = {
  goalId: string;
  objective: string;
  status: KimiGoalStatus;
} | null;

export type KimiWebGoalClientOptions = {
  /** Explicit server origin, e.g. `http://127.0.0.1:58627`. */
  baseUrl?: string;
  /** Explicit bearer token. */
  token?: string;
  /** Kimi home directory; defaults to the current OS home. */
  kimiHome?: string;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
};

type InstanceFile = {
  host?: unknown;
  port?: unknown;
};

export class KimiWebGoalClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KimiWebGoalClientOptions = {}) {
    const explicitBaseUrl = options.baseUrl?.trim();
    this.baseUrl = (explicitBaseUrl || "").replace(/\/+$/, "");
    this.token = options.token?.trim() || null;
    this.fetchImpl = options.fetch ?? fetch;
  }

  static async discover(
    kimiHome = path.join(os.homedir(), DEFAULT_SERVER_DIR),
  ): Promise<{ baseUrl: string; token: string }> {
    const instancesDir = path.join(kimiHome, "instances");
    let entries: string[] = [];
    try {
      entries = await readdir(instancesDir);
    } catch {
      throw new Error(
        "找不到 Kimi web 本地服务实例目录（~/.kimi-code/server/instances）",
      );
    }

    let instance: InstanceFile | null = null;
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed: unknown = JSON.parse(
          await readFile(path.join(instancesDir, entry), "utf8"),
        );
        if (isRecord(parsed)) {
          instance = parsed;
          break;
        }
      } catch {
        continue;
      }
    }
    const host = stringValue(instance?.host) || "127.0.0.1";
    const port = Number(instance?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Kimi web 本地服务实例文件缺少有效的 host/port");
    }

    let token = "";
    try {
      token = (await readFile(path.join(kimiHome, "server.token"), "utf8")).trim();
    } catch {
      // The token is optional when the server binds a loopback socket without
      // authentication; the request path then fails with a clear 401/403.
    }
    return {
      baseUrl: `http://${host}:${port}`,
      token,
    };
  }

  async setGoal(sessionId: string, objective: string): Promise<void> {
    const trimmed = objective.trim();
    if (!trimmed) throw new Error("Goal 目标不能为空");
    if (trimmed.length > GOAL_OBJECTIVE_LIMIT) {
      throw new Error("Goal 目标不能超过 4000 个字符");
    }
    await this.updateProfile(sessionId, { goal_objective: trimmed });
  }

  async cancelGoal(sessionId: string): Promise<void> {
    try {
      await this.updateProfile(sessionId, { goal_control: "cancel" });
    } catch (error) {
      // Cancelling a Thread without an active goal is a no-op in the Web UI;
      // tolerate the local server's not-found response the same way.
      const message = error instanceof Error ? error.message : String(error);
      if (/not_found|no active goal|not found/i.test(message)) return;
      throw error;
    }
  }

  async getGoal(sessionId: string): Promise<KimiGoalSnapshot> {
    const payload = await this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`,
      { method: "GET" },
    );
    const data = isRecord(payload) ? payload.data : null;
    if (data === null || data === undefined) return null;
    if (!isRecord(data)) return null;
    const status = stringValue(data.status);
    if (
      status !== "active" &&
      status !== "paused" &&
      status !== "blocked" &&
      status !== "complete"
    ) {
      return null;
    }
    return {
      goalId: stringValue(data.goalId) ?? "",
      objective: stringValue(data.objective) ?? "",
      status,
    };
  }

  private async updateProfile(
    sessionId: string,
    agentConfig: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_config: agentConfig }),
      },
    );
  }

  private async request(
    pathname: string,
    init: RequestInit,
  ): Promise<unknown> {
    if (!this.baseUrl) {
      throw new Error(
        "未配置 Kimi web 本地服务地址（KIMI_WEB_SERVER_URL），且无法自动发现实例",
      );
    }
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...init,
      headers,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Fall through to the status-based error below.
    }
    if (!response.ok) {
      const message = isRecord(payload)
        ? stringValue(payload.msg) || stringValue(payload.message)
        : null;
      throw new Error(
        `Kimi web 服务返回 ${response.status}${message ? `：${message}` : ""}`,
      );
    }
    const code = isRecord(payload) ? payload.code : null;
    if (typeof code === "number" && code !== 0) {
      const message = isRecord(payload)
        ? stringValue(payload.msg) || stringValue(payload.message)
        : null;
      throw new Error(
        `Kimi web 服务拒绝 Goal 操作（code=${code}）${message ? `：${message}` : ""}`,
      );
    }
    return payload;
  }
}

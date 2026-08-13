import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppServerClientClosedError,
  AppServerRequestTimeoutError,
  AppServerRpcError,
  CodexAppServerClient,
  type AppServerNotification,
} from "../../packages/codex-bridge/src/app-server-client";

const FAKE_APP_SERVER = String.raw`
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex/1.0",
        platformFamily: "unix",
        platformOs: "linux",
        receivedClientInfo: message.params.clientInfo,
        boardTokenPresent: Boolean(process.env.AI_TASK_BOARD_CONNECTION_TOKEN),
        codexAuth: process.env.OPENAI_API_KEY || null,
      },
    });
    return;
  }

  if (message.method === "initialized") {
    send({ method: "server/ready", params: { initialized: true } });
    send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test" },
    });
    return;
  }

  if (message.id === "approval-1" && !message.method) {
    send({ method: "test/serverRequestResponse", params: message });
    return;
  }

  if (message.method === "test/never") return;
  if (message.method === "test/error") {
    send({
      id: message.id,
      error: { code: 409, message: "thread is busy", data: { retry: false } },
    });
    return;
  }

  const responses = {
    "thread/list": {
      data: [{ id: "thread-listed", cursor: message.params.cursor }],
      nextCursor: null,
      backwardsCursor: null,
    },
    "thread/read": {
      thread: {
        id: message.params.threadId,
        turns: message.params.includeTurns ? [{ id: "turn-read", items: [] }] : [],
      },
    },
    "thread/turns/list": {
      data: [{
        id: "turn-listed",
        status: "completed",
        itemsView: message.params.itemsView,
        items: [{ type: "agentMessage", id: "item-listed", text: "Done" }],
      }],
      nextCursor: null,
      backwardsCursor: "newer-cursor",
    },
    "thread/items/list": {
      data: [{
        turnId: message.params.turnId,
        item: { type: "agentMessage", id: "item-paged", text: "Done" },
      }],
      nextCursor: null,
      backwardsCursor: "newer-item-cursor",
    },
    "thread/start": {
      thread: { id: "thread-started", cwd: message.params.cwd },
    },
    "thread/resume": {
      thread: { id: message.params.threadId, resumed: true },
      model: message.params.model ?? "gpt-5.6-sol",
      reasoningEffort:
        message.params.config?.model_reasoning_effort ?? "max",
    },
    "thread/name/set": {},
    "thread/delete": {},
    "thread/archive": {},
    "turn/start": {
      turn: {
        id: "turn-started",
        input: message.params.input,
        model: message.params.model,
        effort: message.params.effort,
      },
    },
    "turn/steer": {
      turnId: message.params.expectedTurnId,
    },
    "turn/interrupt": {},
  };

  const result = responses[message.method];
  if (result) send({ id: message.id, result });
  else send({ id: message.id, error: { code: -32601, message: "unknown method" } });
});
`;

const clients = new Set<CodexAppServerClient>();

function createClient(
  options: ConstructorParameters<typeof CodexAppServerClient>[0] = {},
): CodexAppServerClient {
  const client = new CodexAppServerClient({
    binary: process.execPath,
    args: ["--eval", FAKE_APP_SERVER],
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
    ...options,
  });
  clients.add(client);
  return client;
}

function nextNotification(
  client: CodexAppServerClient,
  method: string,
): Promise<AppServerNotification> {
  return new Promise((resolve) => {
    const unsubscribe = client.onNotification((notification) => {
      if (notification.method !== method) return;
      unsubscribe();
      resolve(notification);
    });
  });
}

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
});

describe("CodexAppServerClient", () => {
  it("initializes over JSONL and exposes thread and turn helpers", async () => {
    const handler = vi.fn(async (request) => ({
      decision: "accept",
      requestMethod: request.method,
    }));
    const client = createClient({
      clientInfo: {
        name: "test_bridge",
        title: "Test Bridge",
        version: "9.8.7",
      },
      serverRequestHandler: handler,
    });
    const ready = nextNotification(client, "server/ready");
    const approvalResponse = nextNotification(
      client,
      "test/serverRequestResponse",
    );

    const initialized = await client.initialize();
    expect(initialized).toMatchObject({
      userAgent: "fake-codex/1.0",
      receivedClientInfo: {
        name: "test_bridge",
        title: "Test Bridge",
        version: "9.8.7",
      },
    });
    expect(client.isInitialized).toBe(true);
    await expect(ready).resolves.toMatchObject({
      params: { initialized: true },
    });
    await expect(approvalResponse).resolves.toMatchObject({
      params: {
        id: "approval-1",
        result: {
          decision: "accept",
          requestMethod: "item/commandExecution/requestApproval",
        },
      },
    });
    expect(handler).toHaveBeenCalledWith({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test" },
    });

    await expect(client.threadList({ cursor: "page-2" })).resolves.toMatchObject({
      data: [{ id: "thread-listed", cursor: "page-2" }],
      nextCursor: null,
    });
    await expect(
      client.threadRead({ threadId: "thread-existing", includeTurns: true }),
    ).resolves.toMatchObject({
      thread: { id: "thread-existing", turns: [{ id: "turn-read" }] },
    });
    await expect(
      client.threadTurnsList({
        threadId: "thread-existing",
        limit: 50,
        sortDirection: "desc",
        itemsView: "full",
      }),
    ).resolves.toMatchObject({
      data: [{ id: "turn-listed", itemsView: "full" }],
      nextCursor: null,
    });
    await expect(
      client.threadItemsList({
        threadId: "thread-existing",
        turnId: "turn-listed",
        sortDirection: "asc",
      }),
    ).resolves.toMatchObject({
      data: [{ turnId: "turn-listed", item: { id: "item-paged" } }],
      nextCursor: null,
    });
    await expect(client.threadStart({ cwd: "/workspace" })).resolves.toMatchObject({
      thread: { id: "thread-started", cwd: "/workspace" },
    });
    await expect(
      client.threadResume({
        threadId: "thread-existing",
        model: "gpt-5.6-terra",
        config: { model_reasoning_effort: "high" },
      }),
    ).resolves.toMatchObject({
      thread: { id: "thread-existing", resumed: true },
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
    await expect(
      client.threadSetName({ threadId: "thread-existing", name: "New name" }),
    ).resolves.toEqual({});
    await expect(
      client.threadDelete({ threadId: "thread-existing" }),
    ).resolves.toEqual({});
    await expect(
      client.threadArchive({ threadId: "thread-existing" }),
    ).resolves.toEqual({});
    await expect(
      client.turnStart({
        threadId: "thread-existing",
        input: [{ type: "text", text: "Run tests" }],
        model: "gpt-5.6-terra",
        effort: "high",
      }),
    ).resolves.toMatchObject({
      turn: {
        id: "turn-started",
        model: "gpt-5.6-terra",
        effort: "high",
      },
    });
    await expect(
      client.turnSteer({
        threadId: "thread-existing",
        expectedTurnId: "turn-started",
        input: [{ type: "text", text: "Also lint" }],
      }),
    ).resolves.toEqual({ turnId: "turn-started" });
    await expect(
      client.turnInterrupt({
        threadId: "thread-existing",
        turnId: "turn-started",
      }),
    ).resolves.toEqual({});
    expect(client.pendingRequestCount).toBe(0);
  });

  it("rejects RPC errors and removes timed-out requests from pending state", async () => {
    const client = createClient();
    await client.initialize();

    const rpcError = await client.request("test/error").catch((error) => error);
    expect(rpcError).toBeInstanceOf(AppServerRpcError);
    expect(rpcError).toMatchObject({
      code: 409,
      message: "thread is busy",
      data: { retry: false },
      method: "test/error",
    });

    const timeout = client.request("test/never", {}, { timeoutMs: 20 });
    await expect(timeout).rejects.toBeInstanceOf(AppServerRequestTimeoutError);
    expect(client.pendingRequestCount).toBe(0);
    await expect(client.threadList()).resolves.toMatchObject({
      data: [{ id: "thread-listed" }],
    });
  });

  it("rejects outstanding requests and lets the child exit when closed", async () => {
    const client = createClient();
    await client.initialize();
    const pending = client.request("test/never", {}, { timeoutMs: 0 });
    const rejected = expect(pending).rejects.toBeInstanceOf(
      AppServerClientClosedError,
    );

    await client.close();

    await rejected;
    expect(client.isClosed).toBe(true);
    expect(client.pendingRequestCount).toBe(0);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("can remove Bridge-only secrets while preserving Codex authentication", async () => {
    const client = createClient({
      env: {
        ...process.env,
        AI_TASK_BOARD_CONNECTION_TOKEN: "atb_must_not_reach_codex",
        OPENAI_API_KEY: "codex_auth_is_preserved",
      },
      unsetEnv: ["AI_TASK_BOARD_CONNECTION_TOKEN"],
    });

    await expect(client.initialize()).resolves.toMatchObject({
      boardTokenPresent: false,
      codexAuth: "codex_auth_is_preserved",
    });
  });

  it("aborts an unbounded request and removes it from pending state", async () => {
    const client = createClient();
    await client.initialize();
    const controller = new AbortController();
    const pending = client.request("test/never", {}, {
      timeoutMs: 0,
      signal: controller.signal,
    });

    controller.abort(new Error("bridge stopping"));

    await expect(pending).rejects.toThrow("bridge stopping");
    expect(client.pendingRequestCount).toBe(0);
  });
});

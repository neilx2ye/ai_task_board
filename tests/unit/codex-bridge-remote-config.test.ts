import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const FAKE_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-config-codex" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{
        id: "thread-config",
        name: "Secret thread title",
        preview: "Secret first prompt",
        cwd: "/workspace/project",
        parentThreadId: null,
      }],
      nextCursor: null,
    } });
  }
});
`;

const DELAYED_RETIREMENT_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const threads = [
  { id: "thread-a", name: "Alpha", cwd: "/workspace/project", parentThreadId: null },
  { id: "thread-b", name: "Beta", cwd: "/workspace/project", parentThreadId: null },
];
let turnNumber = 0;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-delayed-retirement" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: threads.slice(0, message.params.limit || threads.length),
      nextCursor: null,
    } });
  } else if (message.method === "thread/resume") {
    const thread = threads.find((candidate) => candidate.id === message.params.threadId);
    send({ id: message.id, result: { thread } });
  } else if (message.method === "turn/start") {
    turnNumber += 1;
    const current = turnNumber;
    process.stderr.write("DELAYED_TURN_START " + current + "\\n");
    setTimeout(() => {
      process.stderr.write("DELAYED_TURN_RESPONSE " + current + "\\n");
      send({ id: message.id, result: {
        turn: { id: "turn-" + current, status: "inProgress" },
      } });
    }, 5000);
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
`;

type Desired = {
  enabled: boolean;
  include_thread_titles: boolean;
  max_threads: number;
  max_concurrent_turns: number;
  working_directories: Array<{
    directory_key: string;
    name: string;
    working_directory: string;
  }> | null;
};

function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
}

async function bodyOf(request: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function waitUntil(
  predicate: () => boolean,
  diagnostics: () => string,
  timeoutMs = 7_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(diagnostics());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Bridge did not stop after SIGTERM")), 5_000),
    ),
  ]);
}

describe("Codex Bridge Web configuration", () => {
  let child: ChildProcess | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    await stopChild(child);
    child = null;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    temporaryDirectory = null;
  });

  it("updates titles, disables inventory, and re-enables workers", async () => {
    let version = 1;
    let desired: Desired = {
      enabled: true,
      include_thread_titles: false,
      max_threads: 40,
      max_concurrent_turns: 20,
      working_directories: null,
    };
    const configurationStatuses: Array<Record<string, unknown>> = [];
    const inventories: Array<Array<Record<string, unknown>>> = [];
    const directoryInventories: Array<Array<Record<string, unknown>>> = [];
    const wakeResponses = new Set<ServerResponse>();
    let failNextEmptySync = false;
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (pathname === "/api/ai/config") {
        configurationStatuses.push(await bodyOf(request));
        json(response, {
          configuration: {
            connection_id: "connection-config",
            version,
            desired,
            applied: null,
            updated_at: new Date().toISOString(),
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        const body = await bodyOf(request);
        const threads = body.threads as Array<Record<string, unknown>>;
        inventories.push(threads);
        directoryInventories.push(
          body.directories as Array<Record<string, unknown>>,
        );
        if (threads.length === 0 && failNextEmptySync) {
          failNextEmptySync = false;
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "sync failed after retirement" } }));
          return;
        }
        json(response, {
          sessions: threads.map((thread) => ({
            id: "session-config",
            external_conversation_ref: thread.external_conversation_ref,
          })),
        });
        return;
      }
      if (pathname === "/api/ai/sessions/wake") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": connected\n\n");
        wakeResponses.add(response);
        response.on("close", () => wakeResponses.delete(response));
        return;
      }
      if (pathname === "/api/ai/tasks/claim-next") {
        json(response, { task: null });
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-config-test-"));
    const remoteDirectory = path.join(temporaryDirectory, "remote-project");
    await mkdir(remoteDirectory);
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_config_token",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
          AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
          AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "true",
          CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES: "true",
          CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES: "true",
          CODEX_BRIDGE_INCLUDE_THREAD_TITLES: "false",
          CODEX_MAX_THREADS: "4",
          CODEX_MAX_CONCURRENT_TURNS: "3",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
          CODEX_BRIDGE_PERMISSION_MODE: "safe",
          CODEX_BRIDGE_APPROVAL_MODE: "decline",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitUntil(
        () =>
          inventories.some(
            (threads) =>
              threads.length === 1 &&
              String(threads[0]?.name).includes("project · thread-c"),
          ),
        () => `private inventory was not synced\n${stdout}\n${stderr}`,
      );

      version = 2;
      desired = {
        ...desired,
        include_thread_titles: true,
        max_threads: 4,
        max_concurrent_turns: 2,
        working_directories: [
          {
            directory_key: "remote",
            name: "Remote project",
            working_directory: remoteDirectory,
          },
        ],
      };
      const titleChangeStart = inventories.length;
      await waitUntil(
        () =>
          inventories.slice(titleChangeStart).some(
            (threads) =>
              threads.length === 1 &&
              String(threads[0]?.name).includes("Secret thread title"),
          ),
        () => `title change was not synced\n${stdout}\n${stderr}`,
      );
      expect(directoryInventories.slice(titleChangeStart)).toContainEqual([
        {
          directory_key: "remote",
          name: "Remote project",
          working_directory: remoteDirectory,
        },
      ]);

      version = 3;
      desired = { ...desired, enabled: false };
      failNextEmptySync = true;
      const disableStart = inventories.length;
      await waitUntil(
        () =>
          configurationStatuses.some(
            (status) =>
              status.applied_version === 2 &&
              status.effective === null &&
              String(status.error).includes("sync failed after retirement"),
          ),
        () => `partial retirement did not report unknown effective state\n${stdout}\n${stderr}`,
      );
      expect(
        configurationStatuses.some((status) => status.applied_version === 3),
      ).toBe(false);
      await waitUntil(
        () =>
          configurationStatuses.some((status) => status.applied_version === 3) &&
          inventories.slice(disableStart).filter((threads) => threads.length === 0)
            .length >= 2,
        () => `empty authoritative inventory was not synced\n${stdout}\n${stderr}`,
      );

      version = 4;
      desired = { ...desired, enabled: true };
      const reenableStart = inventories.length;
      await waitUntil(
        () => inventories.slice(reenableStart).some((threads) => threads.length === 1),
        () => `inventory was not re-enabled\n${stdout}\n${stderr}`,
      );
      await waitUntil(
        () => configurationStatuses.some((status) => status.applied_version === 4),
        () => `version 4 was not re-reported\n${stdout}\n${stderr}`,
      );

      version = 5;
      desired = {
        ...desired,
        working_directories: [
          {
            directory_key: "missing",
            name: "Missing project",
            working_directory: path.join(
              temporaryDirectory,
              "does-not-exist",
            ),
          },
        ],
      };
      const invalidStart = configurationStatuses.length;
      await waitUntil(
        () =>
          configurationStatuses.slice(invalidStart).some(
            (status) =>
              status.applied_version === 4 &&
              String(status.error).includes("应用 version=5 失败") &&
              String(status.error).includes("不存在或不是目录") &&
              Array.isArray(
                (status.effective as Record<string, unknown> | null)
                  ?.working_directories,
              ),
          ),
        () => `invalid directory config was not rejected and reported\n${stdout}\n${stderr}`,
      );
      expect(
        configurationStatuses.some((status) => status.applied_version === 5),
      ).toBe(false);
    } finally {
      await stopChild(child);
      child = null;
      for (const response of wakeResponses) response.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const finalStatus = configurationStatuses.find(
      (status) => status.applied_version === 4,
    );
    const rejectedStatus = configurationStatuses.find(
      (status) =>
        status.applied_version === 4 &&
        String(status.error).includes("应用 version=5 失败"),
    );
    expect(
      configurationStatuses.find((status) => status.applied_version === 1),
    ).toMatchObject({
      effective: {
        max_threads: 4,
        max_concurrent_turns: 3,
      },
      error: expect.stringContaining("max_threads=40"),
    });
    expect(finalStatus).toMatchObject({
      runtime_instance_id: expect.any(String),
      report_sequence: expect.any(Number),
      lease_seconds: 15,
      release_runtime: false,
      applied_version: 4,
      effective: {
        enabled: true,
        include_thread_titles: true,
        max_threads: 4,
        max_concurrent_turns: 2,
        working_directories: [
          {
            directory_key: "remote",
            name: "Remote project",
            working_directory: remoteDirectory,
          },
        ],
      },
      constraints: {
        remote_configuration_enabled: true,
        allow_thread_titles: true,
        allow_working_directory_configuration: true,
        max_threads: 4,
        max_concurrent_turns: 3,
        thread_scope: "all",
        working_directory: temporaryDirectory,
        fixed_thread: false,
        permission_mode: "safe",
        approval_mode: "decline",
      },
      error: null,
    });
    expect(rejectedStatus).toMatchObject({
      effective: {
        working_directories: [
          {
            directory_key: "remote",
            name: "Remote project",
            working_directory: remoteDirectory,
          },
        ],
      },
    });
    expect(new Set(configurationStatuses.map((status) => status.runtime_instance_id))).toHaveLength(1);
    const sequences = configurationStatuses.map((status) => Number(status.report_sequence));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(Math.min(...sequences)).toBe(1);
    const releaseStatus = configurationStatuses.find(
      (status) => status.release_runtime === true,
    );
    expect(releaseStatus).toMatchObject({
      report_sequence: Math.max(...sequences),
      release_runtime: true,
    });
  }, 20_000);

  it("does not acknowledge max-thread or disable changes until blocked workers retire", async () => {
    let version = 1;
    let desired: Desired = {
      enabled: true,
      include_thread_titles: false,
      max_threads: 2,
      max_concurrent_turns: 2,
      working_directories: null,
    };
    let availableTasks = 1;
    let claimedTasks = 0;
    const statuses: Array<Record<string, unknown>> = [];
    const inventories: Array<Array<Record<string, unknown>>> = [];
    const wakeResponses = new Set<ServerResponse>();
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      const sessionId = String(request.headers["x-ai-session-id"] ?? "");
      if (pathname === "/api/ai/config") {
        statuses.push(await bodyOf(request));
        json(response, {
          configuration: {
            connection_id: "connection-retirement",
            version,
            desired,
            applied: null,
            updated_at: new Date().toISOString(),
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        const body = await bodyOf(request);
        const threads = body.threads as Array<Record<string, unknown>>;
        inventories.push(threads);
        json(response, {
          sessions: threads.map((thread) => ({
            id: `session-${thread.external_conversation_ref}`,
            external_conversation_ref: thread.external_conversation_ref,
          })),
        });
        return;
      }
      if (pathname === "/api/ai/sessions/wake") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("event: ready\n\n");
        wakeResponses.add(response);
        response.on("close", () => wakeResponses.delete(response));
        return;
      }
      if (pathname === "/api/ai/tasks/claim-next") {
        if (sessionId === "session-thread-b" && claimedTasks < availableTasks) {
          claimedTasks += 1;
          json(response, {
            task: {
              id: `task-${claimedTasks}`,
              title: `Delayed retirement ${claimedTasks}`,
              description: "Wait for the delayed App Server response",
              acceptance_criteria: null,
              claim_token: `claim-${claimedTasks}`,
            },
          });
        } else {
          json(response, { task: null });
        }
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-retirement-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, DELAYED_RETIREMENT_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_retirement",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
          AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
          AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "true",
          CODEX_MAX_THREADS: "2",
          CODEX_MAX_CONCURRENT_TURNS: "2",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitUntil(
        () => stderr.includes("DELAYED_TURN_START 1"),
        () => `first delayed turn did not start\n${stdout}\n${stderr}`,
      );
      version = 2;
      desired = { ...desired, max_threads: 1 };
      await waitUntil(
        () =>
          statuses.some(
            (status) =>
              status.applied_version === 1 &&
              String(status.error).includes("暂缓同步"),
          ),
        () => `maxThreads retirement was not reported as pending\n${stdout}\n${stderr}`,
      );
      expect(
        statuses.find(
          (status) =>
            status.applied_version === 1 &&
            String(status.error).includes("暂缓同步"),
        ),
      ).toMatchObject({ effective: { max_threads: 2 } });
      expect(statuses.some((status) => status.applied_version === 2)).toBe(false);
      await waitUntil(
        () => statuses.some((status) => status.applied_version === 2),
        () => `maxThreads version was not applied after retirement\n${stdout}\n${stderr}`,
        10_000,
      );
      expect(inventories.at(-1)?.map((thread) => thread.external_conversation_ref)).toEqual([
        "thread-a",
      ]);

      availableTasks = 2;
      version = 3;
      desired = { ...desired, max_threads: 2 };
      await waitUntil(
        () => stderr.includes("DELAYED_TURN_START 2"),
        () => `second delayed turn did not start\n${stdout}\n${stderr}`,
        10_000,
      );
      version = 4;
      desired = { ...desired, enabled: false };
      await waitUntil(
        () =>
          statuses.some(
            (status) =>
              status.applied_version === 3 &&
              String(status.error).includes("暂缓同步"),
          ),
        () => `disable retirement was not reported as pending\n${stdout}\n${stderr}`,
      );
      expect(
        statuses.find(
          (status) =>
            status.applied_version === 3 &&
            String(status.error).includes("暂缓同步"),
        ),
      ).toMatchObject({ effective: { enabled: true } });
      expect(statuses.some((status) => status.applied_version === 4)).toBe(false);
      await waitUntil(
        () => statuses.some((status) => status.applied_version === 4),
        () => `disable version was not applied after retirement\n${stdout}\n${stderr}`,
        10_000,
      );
      expect(inventories.at(-1)).toEqual([]);
    } finally {
      await stopChild(child);
      child = null;
      for (const response of wakeResponses) response.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  it("renews the runtime lease while inventory sync is stalled", async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const stalledSyncResponses = new Set<ServerResponse>();
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (pathname === "/api/ai/config") {
        statuses.push(await bodyOf(request));
        json(response, {
          configuration: {
            connection_id: "connection-stalled-sync",
            version: 1,
            desired: {
              enabled: true,
              include_thread_titles: false,
              max_threads: 1,
              max_concurrent_turns: 1,
              working_directories: null,
            },
            applied: null,
            updated_at: new Date().toISOString(),
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        await bodyOf(request);
        stalledSyncResponses.add(response);
        response.on("close", () => stalledSyncResponses.delete(response));
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-stalled-sync-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_stalled_sync",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
          AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "true",
          CODEX_MAX_THREADS: "1",
          CODEX_MAX_CONCURRENT_TURNS: "1",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitUntil(
        () => stalledSyncResponses.size === 1,
        () => `inventory sync did not stall\n${stderr}`,
      );
      await waitUntil(
        () =>
          statuses.filter((status) => status.release_runtime === false).length >= 4,
        () => `runtime lease did not renew during stalled sync\n${stderr}`,
        7_000,
      );
      expect(child.exitCode).toBe(null);
    } finally {
      await stopChild(child);
      child = null;
      for (const response of stalledSyncResponses) response.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const sequences = statuses.map((status) => Number(status.report_sequence));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(Math.min(...sequences)).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ release_runtime: true });
  }, 15_000);

  it("fails fast on a missing config endpoint when Web config is enabled", async () => {
    const server = createServer(async (request, response) => {
      if (request.method !== "GET") await bodyOf(request);
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "config endpoint missing" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-config-404-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_config_404",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const [code] = await Promise.race([
        once(child, "exit"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`404 fail-fast timeout: ${stderr}`)), 5_000),
        ),
      ]);
      child = null;
      expect(code).not.toBe(0);
      expect(stderr).toContain("看板缺少 Bridge 0.4 API");
    } finally {
      await stopChild(child);
      child = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 10_000);

  it("waits before inventory until an older runtime lease can be acquired", async () => {
    let inventoryRequests = 0;
    let configurationRequests = 0;
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (request.method !== "GET") await bodyOf(request);
      if (pathname === "/api/ai/config") {
        configurationRequests += 1;
        if (configurationRequests <= 2) {
          response.writeHead(409, { "Content-Type": "application/json" });
          response.end(JSON.stringify({
            error: {
              code: "BRIDGE_INSTANCE_CONFLICT",
              message: "another runtime owns this connection",
            },
          }));
          return;
        }
        json(response, {
          configuration: {
            connection_id: "connection-conflict-wait",
            version: 1,
            desired: {
              enabled: true,
              include_thread_titles: false,
              max_threads: 1,
              max_concurrent_turns: 1,
              working_directories: null,
            },
            applied: null,
            updated_at: new Date().toISOString(),
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        inventoryRequests += 1;
        json(response, { sessions: [] });
        return;
      }
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-config-conflict-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_config_conflict",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "false",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitUntil(
        () => inventoryRequests >= 1,
        () => `runtime did not acquire the expired lease: ${stderr}`,
        8_000,
      );
      expect(configurationRequests).toBeGreaterThanOrEqual(3);
      expect(stderr).toContain("本实例保持待机并等待接管");
      expect(child.exitCode).toBe(null);
    } finally {
      await stopChild(child);
      child = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 15_000);

  it("self-stops when a held runtime lease receives a conflict", async () => {
    let configurationRequests = 0;
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (request.method !== "GET") await bodyOf(request);
      if (pathname === "/api/ai/config") {
        configurationRequests += 1;
        if (configurationRequests > 1) {
          response.writeHead(409, { "Content-Type": "application/json" });
          response.end(JSON.stringify({
            error: {
              code: "BRIDGE_INSTANCE_CONFLICT",
              message: "runtime lease was replaced",
            },
          }));
          return;
        }
        json(response, {
          configuration: {
            connection_id: "connection-lost-conflict",
            version: 1,
            desired: {
              enabled: true,
              include_thread_titles: false,
              max_threads: 1,
              max_concurrent_turns: 1,
              working_directories: null,
            },
            applied: null,
            updated_at: new Date().toISOString(),
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        json(response, { sessions: [] });
        return;
      }
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-lost-conflict-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_lost_conflict",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "false",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const [code] = await Promise.race([
        once(child, "exit"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`held conflict timeout: ${stderr}`)), 8_000),
        ),
      ]);
      child = null;
      expect(code).not.toBe(0);
      expect(configurationRequests).toBeGreaterThanOrEqual(2);
      expect(stderr).toContain("Bridge 运行实例冲突");
    } finally {
      await stopChild(child);
      child = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 12_000);

  it("self-fences workers before an unrenewed runtime lease can expire", async () => {
    let configurationRequests = 0;
    const wakeResponses = new Set<ServerResponse>();
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (request.method !== "GET") await bodyOf(request);
      if (pathname === "/api/ai/config") {
        configurationRequests += 1;
        if (configurationRequests > 1) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "lease backend unavailable" } }));
          return;
        }
        json(response, {
          configuration: {
            connection_id: "connection-self-fence",
            version: 1,
            desired: {
              enabled: true,
              include_thread_titles: false,
              max_threads: 1,
              max_concurrent_turns: 1,
              working_directories: null,
            },
            applied: null,
            updated_at: new Date().toISOString(),
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        json(response, {
          sessions: [{
            id: "session-self-fence",
            external_conversation_ref: "thread-config",
          }],
        });
        return;
      }
      if (pathname === "/api/ai/sessions/wake") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("event: ready\n\n");
        wakeResponses.add(response);
        response.on("close", () => wakeResponses.delete(response));
        return;
      }
      if (pathname === "/api/ai/tasks/claim-next") {
        json(response, { task: null });
        return;
      }
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-self-fence-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_self_fence",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
          AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "false",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitUntil(
        () => wakeResponses.size === 1,
        () => `worker did not start before lease failures\n${stderr}`,
      );
      const [code] = await Promise.race([
        once(child, "exit"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`self-fence timeout: ${stderr}`)), 22_000),
        ),
      ]);
      child = null;
      expect(code).not.toBe(0);
      expect(configurationRequests).toBeGreaterThan(2);
      expect(stderr).toContain("本地安全期限前续租");
      expect(wakeResponses.size).toBe(0);
    } finally {
      await stopChild(child);
      child = null;
      for (const response of wakeResponses) response.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 25_000);

  it("renews the local gate but ignores desired config when disabled", async () => {
    const statuses: Array<Record<string, unknown>> = [];
    const inventories: Array<Array<Record<string, unknown>>> = [];
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (pathname === "/api/ai/config") {
        statuses.push(await bodyOf(request));
        if (statuses.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 4_000));
        }
        json(response, {
          configuration: {
            connection_id: "connection-local-gate",
            version: 1,
            desired: {
              enabled: false,
              include_thread_titles: true,
              max_threads: 1,
              max_concurrent_turns: 1,
            },
            applied: null,
            updated_at: new Date().toISOString(),
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        const body = await bodyOf(request);
        inventories.push(body.threads as Array<Record<string, unknown>>);
        json(response, { sessions: [] });
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-local-gate-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_local_gate",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "false",
          CODEX_BRIDGE_INCLUDE_THREAD_TITLES: "false",
          CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES: "false",
          CODEX_MAX_THREADS: "4",
          CODEX_MAX_CONCURRENT_TURNS: "3",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitUntil(
        () => inventories.some((threads) => threads.length === 1),
        () => `local inventory was not synced\n${stderr}`,
      );
      await waitUntil(
        () =>
          statuses.filter((status) => status.release_runtime === false).length >= 2,
        () => `delayed initial lease was not renewed\n${stderr}`,
      );
      expect(child.exitCode).toBe(null);
    } finally {
      await stopChild(child);
      child = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const activeStatuses = statuses.filter(
      (status) => status.release_runtime === false,
    );
    expect(activeStatuses.length).toBeGreaterThanOrEqual(2);
    expect(activeStatuses[0]).toMatchObject({
      runtime_instance_id: expect.any(String),
      report_sequence: 1,
      lease_seconds: 15,
      release_runtime: false,
      applied_version: null,
      effective: {
        enabled: true,
        include_thread_titles: false,
        max_threads: 4,
        max_concurrent_turns: 3,
        working_directories: [
          {
            directory_key: "default",
            name: path.basename(temporaryDirectory),
            working_directory: temporaryDirectory,
          },
        ],
      },
      constraints: {
        remote_configuration_enabled: false,
        allow_thread_titles: false,
        allow_working_directory_configuration: false,
        fixed_thread: false,
      },
      error: null,
    });
    expect(statuses.at(-1)).toMatchObject({
      runtime_instance_id: activeStatuses[0]?.runtime_instance_id,
      report_sequence: statuses.length,
      release_runtime: true,
    });
    expect(inventories.at(-1)).toHaveLength(1);
  }, 10_000);
});

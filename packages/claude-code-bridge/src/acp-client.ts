import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  Client,
  InitializeResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import type {
  ClaudeApprovalMode,
  ClaudeBridgeConfiguration,
} from "./config.js";
import { delay, errorMessage, isRecord, redactText } from "./utils.js";

export type InventoryModel = {
  id: string;
  model: string;
  display_name: string;
  description: string | null;
  default_reasoning_effort: string | null;
  supported_reasoning_efforts: Array<{
    reasoning_effort: string;
    description: string | null;
  }>;
  input_modalities: string[];
  is_default: boolean;
};

export const CLAUDE_FALLBACK_MODEL_CATALOG: readonly InventoryModel[] = [
  {
    id: "default",
    model: "default",
    display_name: "Default",
    description: "跟随 Claude Code 当前默认模型",
    default_reasoning_effort: "default",
    supported_reasoning_efforts: ["default", "medium", "high"].map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: true,
  },
  {
    id: "sonnet",
    model: "sonnet",
    display_name: "Sonnet",
    description: "Claude Code 推荐的平衡模型",
    default_reasoning_effort: "default",
    supported_reasoning_efforts: ["default", "medium", "high"].map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
  {
    id: "opus",
    model: "opus",
    display_name: "Opus",
    description: "Claude Code 旗舰编码模型",
    default_reasoning_effort: "default",
    supported_reasoning_efforts: ["default", "medium", "high"].map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
  {
    id: "haiku",
    model: "haiku",
    display_name: "Haiku",
    description: "Claude Code 高速轻量模型",
    default_reasoning_effort: "default",
    supported_reasoning_efforts: ["default", "high"].map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
];

type SessionUpdateHandler = (notification: SessionNotification) => void;

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.AI_TASK_BOARD_CONNECTION_TOKEN;
  delete environment.AI_TASK_BOARD_URL;
  return environment;
}

function flattenSelectOptions(
  option: Extract<SessionConfigOption, { type: "select" }>,
): Array<{ value: string; name: string; description: string | null }> {
  return option.options.flatMap((candidate) => {
    if ("group" in candidate) {
      return candidate.options.map((nested) => ({
        value: nested.value,
        name: nested.name,
        description: nested.description ?? null,
      }));
    }
    return [
      {
        value: candidate.value,
        name: candidate.name,
        description: candidate.description ?? null,
      },
    ];
  });
}

export function selectConfigOption(
  options: readonly SessionConfigOption[] | null | undefined,
  category: "model" | "thought_level" | "mode",
): Extract<SessionConfigOption, { type: "select" }> | null {
  const selected = options?.find(
    (option) =>
      option.type === "select" &&
      (option.category === category || option.id === category),
  );
  return selected?.type === "select" ? selected : null;
}

export function modelCatalogFromConfigOptions(
  options: readonly SessionConfigOption[] | null | undefined,
  supportsImages: boolean,
): InventoryModel[] | null {
  const modelOption = selectConfigOption(options, "model");
  if (!modelOption) return null;
  const effortOption = selectConfigOption(options, "thought_level");
  const efforts = effortOption ? flattenSelectOptions(effortOption) : [];
  return flattenSelectOptions(modelOption).map((model) => ({
    id: model.value,
    model: model.value,
    display_name: model.name,
    description: model.description,
    default_reasoning_effort: effortOption?.currentValue ?? null,
    supported_reasoning_efforts: efforts.map((effort) => ({
      reasoning_effort: effort.value,
      description: effort.description,
    })),
    input_modalities: supportsImages ? ["text", "image"] : ["text"],
    is_default: model.value === modelOption.currentValue,
  }));
}

function permissionOption(
  options: readonly PermissionOption[],
  approvalMode: ClaudeApprovalMode,
  active: boolean,
): PermissionOption | null {
  const allowedKinds =
    approvalMode === "accept" && active
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  for (const kind of allowedKinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option;
  }
  return null;
}

class ClaudeAcpClientHandler implements Client {
  constructor(private readonly owner: ClaudeAcpClient) {}

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.owner.requestPermission(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.owner.receiveSessionUpdate(params);
  }
}

export class ClaudeAcpClient {
  private readonly updateHandlers = new Map<string, SessionUpdateHandler>();
  private readonly activeTaskSessions = new Set<string>();
  private readonly configOptions = new Map<string, SessionConfigOption[]>();
  private readonly connection: acp.ClientSideConnection;
  private closing = false;
  private exitHandler: ((error: Error) => void) | null = null;
  private initializeResponse: InitializeResponse | null = null;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly approvalMode: ClaudeApprovalMode,
  ) {
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    this.connection = new acp.ClientSideConnection(
      () => new ClaudeAcpClientHandler(this),
      stream,
    );
    child.stderr.on("data", (chunk: Buffer | string) => {
      const message = redactText(String(chunk), 20_000);
      process.stderr.write(`[claude acp] ${message}`);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => {
      if (this.closing) return;
      this.handleExit(
        new Error(
          `Claude ACP 意外退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`,
        ),
      );
    });
  }

  static async start(
    configuration: ClaudeBridgeConfiguration,
  ): Promise<ClaudeAcpClient> {
    const args =
      path.basename(configuration.claudeBinary) === "npx"
        ? ["-y", "@agentclientprotocol/claude-agent-acp"]
        : [];
    const child = spawn(configuration.claudeBinary, args, {
      cwd: configuration.workingDirectories[0]?.workingDirectory ?? process.cwd(),
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new ClaudeAcpClient(child, configuration.approvalMode);
    let rejectStartup!: (error: Error) => void;
    const startupFailure = new Promise<never>((_resolve, reject) => {
      rejectStartup = reject;
    });
    const startupError = (error: Error) => rejectStartup(error);
    client.exitHandler = startupError;
    try {
      const initialized = await Promise.race([
        client.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "AI Task Board Claude Bridge",
            title: "AI Task Board Claude Bridge",
            version: "0.1.0",
          },
        }),
        startupFailure,
      ]);
      client.initializeResponse = initialized;
      client.assertCapabilities(initialized);
      client.exitHandler = null;
      return client;
    } catch (error) {
      await client.close();
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        throw new Error(
          `找不到 Claude Code ACP 可执行文件：${configuration.claudeBinary}。` +
            "请先运行 npm install -g @agentclientprotocol/claude-agent-acp，" +
            "或通过 CLAUDE_BINARY 指定其路径",
          { cause: error },
        );
      }
      throw new Error(`无法启动 Claude ACP：${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  get supportsImages(): boolean {
    return (
      this.initializeResponse?.agentCapabilities?.promptCapabilities?.image ===
      true
    );
  }

  get agentDescription(): string {
    const info = this.initializeResponse?.agentInfo;
    return info ? `${info.title ?? info.name} ${info.version}` : "Claude Code";
  }

  get supportsGoals(): boolean {
    const goal = (this.initializeResponse?._meta as
      | Record<string, unknown>
      | undefined)?.goal;
    return (
      isRecord(goal) &&
      typeof goal.controlMethod === "string" &&
      Array.isArray(goal.actions) &&
      goal.actions.includes("set") &&
      goal.actions.includes("clear")
    );
  }

  onUnexpectedExit(handler: (error: Error) => void): void {
    this.exitHandler = handler;
  }

  setTaskActive(sessionId: string, active: boolean): void {
    if (active) this.activeTaskSessions.add(sessionId);
    else this.activeTaskSessions.delete(sessionId);
  }

  subscribe(sessionId: string, handler: SessionUpdateHandler): () => void {
    if (this.updateHandlers.has(sessionId)) {
      throw new Error(`Claude session ${sessionId} 已有活动订阅`);
    }
    this.updateHandlers.set(sessionId, handler);
    return () => {
      if (this.updateHandlers.get(sessionId) === handler) {
        this.updateHandlers.delete(sessionId);
      }
    };
  }

  receiveSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      this.configOptions.set(notification.sessionId, update.configOptions);
    }
    this.updateHandlers.get(notification.sessionId)?.(notification);
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const active = this.activeTaskSessions.has(params.sessionId);
    const selected = permissionOption(params.options, this.approvalMode, active);
    const action = selected?.kind.startsWith("allow") ? "批准" : "拒绝";
    process.stderr.write(
      `Claude 权限请求已${action} [${params.sessionId}]：${redactText(
        params.toolCall.title ?? "未命名工具",
        500,
      )}\n`,
    );
    return selected
      ? {
          outcome: {
            outcome: "selected",
            optionId: selected.optionId,
          },
        }
      : { outcome: { outcome: "cancelled" } };
  }

  async listAllSessions(cwd: string): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await this.connection.listSessions({ cwd, cursor });
      sessions.push(...response.sessions);
      const nextCursor = response.nextCursor ?? null;
      if (!nextCursor) break;
      if (cursors.has(nextCursor)) {
        throw new Error("Claude ACP session/list 返回了重复游标");
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    } while (sessions.length < 5_000);
    return sessions;
  }

  async newSession(cwd: string): Promise<{
    sessionId: string;
    configOptions: SessionConfigOption[];
  }> {
    const response = await this.connection.newSession({ cwd, mcpServers: [] });
    const options = response.configOptions ?? [];
    this.configOptions.set(response.sessionId, options);
    return { sessionId: response.sessionId, configOptions: options };
  }

  async resumeSession(session: SessionInfo): Promise<SessionConfigOption[]> {
    const response = await this.connection.resumeSession({
      sessionId: session.sessionId,
      cwd: session.cwd,
      mcpServers: [],
    });
    const options = response.configOptions ?? [];
    this.configOptions.set(session.sessionId, options);
    return options;
  }

  async setConfigValue(
    sessionId: string,
    options: readonly SessionConfigOption[],
    category: "model" | "thought_level" | "mode",
    value: string,
  ): Promise<SessionConfigOption[]> {
    const option = selectConfigOption(options, category);
    if (!option) {
      throw new Error(`当前 Claude Code 不提供 ${category} 配置项`);
    }
    const allowed = flattenSelectOptions(option).some(
      (candidate) => candidate.value === value,
    );
    if (!allowed) {
      throw new Error(`当前 Claude Code 不支持 ${category}=${value}`);
    }
    if (option.currentValue === value) return [...options];
    const response = await this.connection.setSessionConfigOption({
      sessionId,
      configId: option.id,
      value,
    });
    this.configOptions.set(sessionId, response.configOptions);
    return response.configOptions;
  }

  selectedValue(
    sessionId: string,
    category: "model" | "thought_level" | "mode",
  ): string | null {
    return selectConfigOption(this.configOptions.get(sessionId), category)
      ?.currentValue ?? null;
  }

  async prompt(
    sessionId: string,
    messageId: string,
    prompt: acp.ContentBlock[],
  ): Promise<PromptResponse> {
    return this.connection.prompt({ sessionId, messageId, prompt });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.connection.cancel({ sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.initializeResponse?.agentCapabilities?.sessionCapabilities?.close) {
      return;
    }
    await this.connection.closeSession({ sessionId });
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.initializeResponse?.agentCapabilities?.sessionCapabilities?.delete) {
      throw new Error("当前 Claude Code ACP 不支持删除 Session");
    }
    await this.connection.unstable_deleteSession({ sessionId });
    this.configOptions.delete(sessionId);
  }

  async setGoal(sessionId: string, objective: string): Promise<void> {
    if (!this.supportsGoals) {
      throw new Error("当前 Claude Code ACP 不支持 Goal 扩展");
    }
    // The ACP SDK in use exposes no generic out-of-band request method, and
    // claude-agent-acp implements goal/set on an idle session through the
    // ordinary prompt lifecycle. Sending the documented `/goal` slash command
    // matches that behaviour while staying inside the public protocol.
    await this.connection.prompt({
      sessionId,
      messageId: `goal-set-${randomUUID()}`,
      prompt: [{ type: "text", text: `/goal ${objective}` }],
    });
  }

  async clearGoal(sessionId: string): Promise<void> {
    if (!this.supportsGoals) {
      throw new Error("当前 Claude Code ACP 不支持 Goal 扩展");
    }
    await this.connection.prompt({
      sessionId,
      messageId: `goal-clear-${randomUUID()}`,
      prompt: [{ type: "text", text: "/goal clear" }],
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.exitHandler = null;
    await Promise.allSettled(
      [...this.activeTaskSessions].map((sessionId) => this.cancel(sessionId)),
    );
    this.child.kill("SIGTERM");
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
        delay(2_000),
      ]);
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
  }

  private assertCapabilities(response: InitializeResponse): void {
    const sessions = response.agentCapabilities?.sessionCapabilities;
    const missing = [
      !sessions?.list ? "session/list" : null,
      !sessions?.resume ? "session/resume" : null,
      !sessions?.delete ? "session/delete" : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Claude ACP 缺少必要能力：${missing.join("、")}`);
    }
  }

  private handleExit(error: Error): void {
    if (!this.closing) this.exitHandler?.(error);
  }
}

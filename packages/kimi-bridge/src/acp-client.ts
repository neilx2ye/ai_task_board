import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  KimiApprovalMode,
  KimiBridgeConfiguration,
} from "./config.js";
import { delay, errorMessage, redactText } from "./utils.js";

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

export const KIMI_FALLBACK_MODEL_CATALOG: readonly InventoryModel[] = [
  {
    id: "kimi-code/k3",
    model: "kimi-code/k3",
    display_name: "K3",
    description: "Kimi Code 默认编码模型",
    default_reasoning_effort: "max",
    supported_reasoning_efforts: ["low", "high", "max"].map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: true,
  },
  {
    id: "kimi-code/k3-256k",
    model: "kimi-code/k3-256k",
    display_name: "K3-256k",
    description: "Kimi Code 长上下文编码模型",
    default_reasoning_effort: "max",
    supported_reasoning_efforts: ["low", "high", "max"].map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
  {
    id: "kimi-code/kimi-for-coding",
    model: "kimi-code/kimi-for-coding",
    display_name: "K2.7 Coding",
    description: "Kimi Code 编码模型",
    default_reasoning_effort: "max",
    supported_reasoning_efforts: ["low", "high", "max"].map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
  {
    id: "kimi-code/kimi-for-coding-highspeed",
    model: "kimi-code/kimi-for-coding-highspeed",
    display_name: "K2.7 Coding Highspeed",
    description: "Kimi Code 高速编码模型",
    default_reasoning_effort: "max",
    supported_reasoning_efforts: ["low", "high", "max"].map(
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
  approvalMode: KimiApprovalMode,
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

class KimiAcpClientHandler implements Client {
  constructor(private readonly owner: KimiAcpClient) {}

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.owner.requestPermission(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.owner.receiveSessionUpdate(params);
  }
}

export class KimiAcpClient {
  private readonly updateHandlers = new Map<string, SessionUpdateHandler>();
  private readonly activeTaskSessions = new Set<string>();
  private readonly configOptions = new Map<string, SessionConfigOption[]>();
  private readonly connection: acp.ClientSideConnection;
  private closing = false;
  private exitHandler: ((error: Error) => void) | null = null;
  private initializeResponse: InitializeResponse | null = null;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly approvalMode: KimiApprovalMode,
  ) {
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    this.connection = new acp.ClientSideConnection(
      () => new KimiAcpClientHandler(this),
      stream,
    );
    child.stderr.on("data", (chunk: Buffer | string) => {
      const message = redactText(String(chunk), 20_000);
      process.stderr.write(`[kimi acp] ${message}`);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => {
      if (this.closing) return;
      this.handleExit(
        new Error(
          `Kimi ACP 意外退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`,
        ),
      );
    });
  }

  static async start(
    configuration: KimiBridgeConfiguration,
  ): Promise<KimiAcpClient> {
    const child = spawn(configuration.kimiBinary, ["acp"], {
      cwd: configuration.workingDirectories[0]?.workingDirectory ?? process.cwd(),
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new KimiAcpClient(child, configuration.approvalMode);
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
            name: "AI Task Board Kimi Bridge",
            title: "AI Task Board Kimi Bridge",
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
      throw new Error(`无法启动 Kimi ACP：${errorMessage(error)}`, {
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
    return info ? `${info.title ?? info.name} ${info.version}` : "Kimi Code";
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
      throw new Error(`Kimi session ${sessionId} 已有活动订阅`);
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
      `Kimi 权限请求已${action} [${params.sessionId}]：${redactText(
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
        throw new Error("Kimi ACP session/list 返回了重复游标");
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
      throw new Error(`当前 Kimi Code 不提供 ${category} 配置项`);
    }
    const allowed = flattenSelectOptions(option).some(
      (candidate) => candidate.value === value,
    );
    if (!allowed) {
      throw new Error(`当前 Kimi Code 不支持 ${category}=${value}`);
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
    // 常驻连接上不要 close 后 resume：Kimi ACP 会把 close 后的会话在
    // resume 时重复注册 runtime，从而报 Internal error。仅在确实要
    // 结束进程/会话时调用。
    if (!this.initializeResponse?.agentCapabilities?.sessionCapabilities?.close) {
      return;
    }
    await this.connection.closeSession({ sessionId });
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.initializeResponse?.agentCapabilities?.sessionCapabilities?.delete) {
      throw new Error("当前 Kimi Code ACP 不支持删除 Session");
    }
    await this.connection.unstable_deleteSession({ sessionId });
    this.configOptions.delete(sessionId);
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
      throw new Error(`Kimi ACP 缺少必要能力：${missing.join("、")}`);
    }
  }

  private handleExit(error: Error): void {
    if (!this.closing) this.exitHandler?.(error);
  }
}

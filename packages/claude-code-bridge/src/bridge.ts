import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  ContentBlock,
  SessionConfigOption,
  SessionInfo,
  SessionNotification,
  StopReason,
  Usage,
} from "@agentclientprotocol/sdk";

import {
  CLAUDE_FALLBACK_MODEL_CATALOG,
  ClaudeAcpClient,
  modelCatalogFromConfigOptions,
  type InventoryModel,
} from "./acp-client.js";
import {
  actionableBoardError,
  BoardClient,
  commandError,
  commandString,
  CLAUDE_BRIDGE_CAPABILITY_VERSION,
  type BoardSession,
  type ClaimedTask,
  type FileCommand,
  type InventoryThread,
  type RemoteConfigurationResponse,
  type RemoteDesiredConfiguration,
  type ThreadCommand,
} from "./board-client.js";
import {
  listDeviceDirectory,
  readDeviceFilePreview,
  type DeviceFileListResult,
  type DeviceFilePreviewResult,
} from "./device-file-access.js";
import {
  directoryForWorkingDirectory,
  loadConfiguration,
  parseRemoteWorkingDirectories,
  workingDirectoryForKey,
  type ClaudeBridgeConfiguration,
  type ManagedWorkingDirectory,
} from "./config.js";
import { maybeApplyDesiredBridgeUpdate } from "./update-manager.js";
import {
  appendBoundedText,
  delay,
  errorMessage,
  errorStatus,
  isPersistentClientError,
  redactText,
  sanitizeValue,
  stringValue,
} from "./utils.js";

const ACP_PROTOCOL = "claude-acp/v1";
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_THREADS = 500;
const MAX_CONCURRENT_TURNS = 32;
const MAX_HISTORY_TURNS = 500;

export class TurnLimiter {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(private limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("TurnLimiter limit 必须是正整数");
    }
  }

  get capacity(): number {
    return this.limit;
  }

  resize(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("TurnLimiter limit 必须是正整数");
    }
    this.limit = limit;
    this.drain();
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => undefined,
      };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseFunction());
    }
  }
}

function clampedRemoteInteger(
  value: number,
  maximum: number,
  field: string,
  warnings: string[],
): number {
  if (!Number.isInteger(value)) {
    throw new Error(`看板配置 ${field} 必须是整数`);
  }
  const clamped = Math.min(maximum, Math.max(1, value));
  if (clamped !== value) {
    warnings.push(
      `${field}=${value} 超出设备允许范围，已限制为 ${clamped}`,
    );
  }
  return clamped;
}

export type ResolvedClaudeRemoteConfiguration = {
  effective: {
    enabled: boolean;
    includeThreadTitles: boolean;
    maxThreads: number;
    maxConcurrentTurns: number;
    syncHistory: boolean;
    historyTurnLimit: number;
    workingDirectories: ManagedWorkingDirectory[];
  };
  warnings: string[];
};

export function resolveRemoteConfiguration(
  configuration: ClaudeBridgeConfiguration,
  desired: RemoteDesiredConfiguration,
): ResolvedClaudeRemoteConfiguration {
  if (typeof desired.enabled !== "boolean") {
    throw new Error("看板配置 enabled 必须是布尔值");
  }
  if (typeof desired.include_thread_titles !== "boolean") {
    throw new Error("看板配置 include_thread_titles 必须是布尔值");
  }
  if (typeof desired.sync_history !== "boolean") {
    throw new Error("看板配置 sync_history 必须是布尔值");
  }
  const warnings: string[] = [];
  const includeThreadTitles =
    desired.include_thread_titles &&
    configuration.allowRemoteThreadTitles;
  if (desired.include_thread_titles && !includeThreadTitles) {
    warnings.push(
      "看板请求上传 Session 标题，但设备未启用 CLAUDE_BRIDGE_ALLOW_REMOTE_THREAD_TITLES",
    );
  }
  if (desired.sync_history) {
    warnings.push("Claude Bridge 不支持历史同步，忽略看板的历史同步请求");
  }
  let workingDirectories = configuration.localWorkingDirectories.map(
    (directory) => ({ ...directory }),
  );
  if (
    desired.working_directories !== null &&
    desired.working_directories !== undefined
  ) {
    if (configuration.allowRemoteWorkingDirectories) {
      workingDirectories = parseRemoteWorkingDirectories(
        desired.working_directories,
      );
    } else {
      warnings.push(
        "看板请求配置工作目录，但设备未启用 CLAUDE_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION；继续使用本机启动目录",
      );
    }
  }
  return {
    effective: {
      enabled: desired.enabled,
      includeThreadTitles,
      maxThreads: clampedRemoteInteger(
        desired.max_threads,
        MAX_THREADS,
        "max_threads",
        warnings,
      ),
      maxConcurrentTurns: clampedRemoteInteger(
        desired.max_concurrent_turns,
        MAX_CONCURRENT_TURNS,
        "max_concurrent_turns",
        warnings,
      ),
      // History import is not implemented by this runtime. The inert limit
      // mirrors the Web desired value so the disabled feature never reports
      // a spurious applied/effective mismatch.
      syncHistory: false,
      historyTurnLimit: clampedRemoteInteger(
        desired.history_turn_limit ?? 50,
        MAX_HISTORY_TURNS,
        "history_turn_limit",
        warnings,
      ),
      workingDirectories,
    },
    warnings,
  };
}

type PreparedSession = {
  options: SessionConfigOption[];
  model: string | null;
  reasoningEffort: string | null;
};

export async function prepareClaudeSession(
  acp: ClaudeAcpClient,
  session: SessionInfo,
  configuration: Pick<ClaudeBridgeConfiguration, "agentMode">,
  requestedModel: string | null,
  requestedReasoningEffort: string | null,
  existingOptions?: readonly SessionConfigOption[],
): Promise<PreparedSession> {
  let options = existingOptions
    ? [...existingOptions]
    : await acp.resumeSession(session);
  if (requestedModel) {
    options = await acp.setConfigValue(
      session.sessionId,
      options,
      "model",
      requestedModel,
    );
  }
  if (requestedReasoningEffort) {
    options = await acp.setConfigValue(
      session.sessionId,
      options,
      "thought_level",
      requestedReasoningEffort,
    );
  }
  options = await acp.setConfigValue(
    session.sessionId,
    options,
    "mode",
    configuration.agentMode,
  );
  return {
    options,
    model: acp.selectedValue(session.sessionId, "model"),
    reasoningEffort: acp.selectedValue(session.sessionId, "thought_level"),
  };
}

class TurnRecorder {
  assistant = "";
  reasoningCharacters = 0;
  toolCalls = 0;
  failedToolCalls = 0;
  planEntries = 0;
  usageUpdate: { used: number; size: number } | null = null;

  consume(notification: SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.assistant = appendBoundedText(
            this.assistant,
            update.content.text,
          );
        }
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.reasoningCharacters += update.content.text.length;
        }
        return;
      case "tool_call":
        this.toolCalls += 1;
        if (update.status === "failed") this.failedToolCalls += 1;
        return;
      case "tool_call_update":
        if (update.status === "failed") this.failedToolCalls += 1;
        return;
      case "plan":
        this.planEntries = update.entries.length;
        return;
      case "usage_update":
        this.usageUpdate = { used: update.used, size: update.size };
        return;
      default:
        return;
    }
  }

  resultData(
    stopReason: StopReason,
    usage: Usage | null | undefined,
    model: string | null,
    reasoningEffort: string | null,
  ): Record<string, unknown> {
    return {
      protocol: ACP_PROTOCOL,
      phase: "completed",
      stop_reason: stopReason,
      model,
      reasoning_effort: reasoningEffort,
      tool_call_count: this.toolCalls,
      failed_tool_call_count: this.failedToolCalls,
      plan_entry_count: this.planEntries,
      reasoning_characters_observed: this.reasoningCharacters,
      usage: sanitizeValue(usage ?? this.usageUpdate),
    };
  }
}

class SessionWorker {
  private readonly stopController = new AbortController();
  private activeClaim: ClaimedTask | null = null;
  private runPromise: Promise<void> | null = null;
  private stopping = false;
  private activePrompt = false;

  constructor(
    private info: SessionInfo,
    private boardSession: BoardSession,
    private readonly configuration: ClaudeBridgeConfiguration,
    private readonly board: BoardClient,
    private readonly acp: ClaudeAcpClient,
    private readonly limiter: TurnLimiter,
    private readonly onModelChanged: (
      sessionId: string,
      model: string | null,
    ) => void,
  ) {}

  get sessionId(): string {
    return this.info.sessionId;
  }

  get busy(): boolean {
    return this.activeClaim !== null || this.activePrompt;
  }

  update(info: SessionInfo, boardSession: BoardSession): void {
    this.info = info;
    this.boardSession = boardSession;
  }

  start(): Promise<void> {
    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }

  async stop(reason = "Claude Bridge 正在停止"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopController.abort(new Error(reason));
    if (this.activePrompt) {
      await this.acp.cancel(this.info.sessionId).catch(() => undefined);
    }
    await Promise.race([this.runPromise ?? Promise.resolve(), delay(3_000)]);
  }

  private async run(): Promise<void> {
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    try {
      await this.heartbeat();
      heartbeatTimer = setInterval(() => {
        if (this.stopping) return;
        const operation = this.activeClaim
          ? this.board.heartbeatClaim(
              this.boardSession.id,
              this.activeClaim,
              this.configuration.leaseSeconds,
              this.stopController.signal,
            )
          : this.heartbeat();
        void operation.catch((error) => {
          if (!this.stopping) {
            process.stderr.write(
              `Claude Session ${this.info.sessionId} 心跳失败：${errorMessage(error)}\n`,
            );
          }
        });
      }, 45_000);

      while (!this.stopping) await this.runOneIteration();
    } catch (error) {
      if (!this.stopping) throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (this.activeClaim) {
        await this.board
          .releaseTask(
            this.boardSession.id,
            this.activeClaim,
            "Claude Bridge 已停止",
          )
          .catch(() => undefined);
        this.activeClaim = null;
      }
    }
  }

  private async runOneIteration(): Promise<void> {
    if (!this.configuration.enabled) {
      // A disabled Bridge keeps its workers alive for presence heartbeats
      // and configuration updates, but never claims new Web turns.
      await delay(
        this.configuration.pollIntervalMs,
        this.stopController.signal,
      );
      return;
    }
    let release: (() => void) | null = null;
    try {
      release = await this.limiter.acquire(this.stopController.signal);
      let task: ClaimedTask | null;
      try {
        task = await this.board.claimTask(
          this.boardSession.id,
          this.configuration.leaseSeconds,
          this.stopController.signal,
        );
      } catch (error) {
        if (errorStatus(error) === 409) {
          release();
          release = null;
          await delay(
            Math.max(10_000, this.configuration.pollIntervalMs),
            this.stopController.signal,
          );
          return;
        }
        throw error;
      }
      if (!task) {
        release();
        release = null;
        await delay(this.configuration.pollIntervalMs, this.stopController.signal);
        return;
      }
      this.activeClaim = task;
      process.stdout.write(
        `开始 Claude 任务 [${this.info.sessionId.slice(0, 8)}]：${task.title}\n`,
      );
      try {
        await this.executeTask(task);
        process.stdout.write(
          `完成 Claude 任务 [${this.info.sessionId.slice(0, 8)}]：${task.title}\n`,
        );
      } catch (error) {
        if (this.stopping) {
          await this.board
            .releaseTask(this.boardSession.id, task, "Claude Bridge 正在停止")
            .catch(() => undefined);
        } else {
          const reason = redactText(errorMessage(error), 10_000);
          await this.board
            .failTask(
              this.boardSession.id,
              task,
              reason,
              this.stopController.signal,
            )
            .catch(() => undefined);
          process.stderr.write(
            `Claude 任务失败 [${this.info.sessionId}]：${reason}\n`,
          );
        }
      } finally {
        this.activeClaim = null;
      }
    } finally {
      release?.();
    }
  }

  private async executeTask(task: ClaimedTask): Promise<void> {
    await this.board.reportProgress(
      this.boardSession.id,
      task,
      this.stopController.signal,
    );

    const text = [
      task.description?.trim() || task.title,
      task.acceptance_criteria
        ? `\n\n验收条件：\n${task.acceptance_criteria}`
        : "",
    ].join("");
    if (task.goal_mode === true || task.goal_mode === false) {
      if (task.goal_mode === true) {
        try {
          await this.acp.setGoal(this.info.sessionId, text);
        } catch (error) {
          throw new Error(
            `无法为 Claude Session 设置 Goal：${errorMessage(error)}`,
            { cause: error },
          );
        }
      } else {
        try {
          await this.acp.clearGoal(this.info.sessionId);
        } catch (error) {
          throw new Error(
            `无法清除 Claude Session 的 Goal：${errorMessage(error)}`,
            { cause: error },
          );
        }
      }
      if (this.stopping) throw new Error("Claude Bridge 正在停止");
    }
    const prepared = await prepareClaudeSession(
      this.acp,
      this.info,
      this.configuration,
      stringValue(task.model),
      stringValue(task.reasoning_effort),
    );
    this.onModelChanged(this.info.sessionId, prepared.model);

    const artifacts = await this.board.taskArtifacts(
      this.boardSession.id,
      task.id,
      this.stopController.signal,
    );
    const images = artifacts.filter((artifact) =>
      IMAGE_MIME_TYPES.has(artifact.mime_type),
    );
    if (images.length > 0 && !this.acp.supportsImages) {
      throw new Error("当前 Claude Code ACP 不支持图片输入");
    }
    const prompt: ContentBlock[] = [{ type: "text", text }];
    for (const artifact of images) {
      const image = await this.board.downloadImage(
        this.boardSession.id,
        artifact,
        this.stopController.signal,
      );
      prompt.push({ type: "image", ...image });
    }

    const recorder = new TurnRecorder();
    const unsubscribe = this.acp.subscribe(this.info.sessionId, (notification) =>
      recorder.consume(notification),
    );
    this.activePrompt = true;
    this.acp.setTaskActive(this.info.sessionId, true);
    let response: Awaited<ReturnType<ClaudeAcpClient["prompt"]>>;
    try {
      response = await this.acp.prompt(this.info.sessionId, task.id, prompt);
    } finally {
      this.activePrompt = false;
      this.acp.setTaskActive(this.info.sessionId, false);
      unsubscribe();
      await this.acp.closeSession(this.info.sessionId).catch(() => undefined);
    }

    if (response.stopReason === "refusal") {
      throw new Error("Claude 拒绝执行本轮任务");
    }
    if (response.stopReason === "cancelled") {
      throw new Error("Claude 本轮任务已取消");
    }
    const resultData = recorder.resultData(
      response.stopReason,
      response.usage,
      prepared.model,
      prepared.reasoningEffort,
    );
    if (recorder.assistant) {
      await this.board.reportAssistantMessage(
        this.boardSession.id,
        this.info.sessionId,
        task,
        recorder.assistant,
        resultData,
        this.stopController.signal,
      );
    }
    await this.board.completeTask(
      this.boardSession.id,
      task,
      recorder.assistant || `Claude Code 已结束本轮（${response.stopReason}）`,
      resultData,
      this.stopController.signal,
    );
  }

  private async heartbeat(): Promise<void> {
    const session = await this.board.heartbeatPresence(
      this.boardSession.id,
      this.stopController.signal,
    );
    if (session) this.boardSession = session;
  }
}

export class ClaudeBridge {
  private readonly stopController = new AbortController();
  private readonly board: BoardClient;
  private readonly limiter: TurnLimiter;
  private readonly runtimeInstanceId = randomUUID();
  private readonly workers = new Map<string, SessionWorker>();
  private readonly workerRuns = new Map<string, Promise<void>>();
  private readonly knownModels = new Map<string, string | null>();
  private readonly createdSessions = new Map<string, SessionInfo>();
  private managedSessionIds = new Set<string>();
  private modelCatalog: InventoryModel[];
  private reportSequence = 0;
  private appliedConfigurationVersion: number | null = null;
  private configurationError: string | null = null;
  private updateError: string | null = null;
  private runtimeLeaseClaimed = false;
  private leaseSafetyDeadline = 0;
  private leaseRenewalPromise: Promise<void> | null = null;
  private stopping = false;
  private fatalError: Error | null = null;
  private stopPromise: Promise<void> | null = null;
  private inventoryReady = false;

  constructor(
    private readonly configuration: ClaudeBridgeConfiguration,
    private readonly acp: ClaudeAcpClient,
  ) {
    this.board = new BoardClient(configuration, () => this.stopping);
    this.limiter = new TurnLimiter(configuration.maxConcurrentTurns);
    this.modelCatalog = CLAUDE_FALLBACK_MODEL_CATALOG.map((model) => ({
      ...model,
      input_modalities: acp.supportsImages ? ["text", "image"] : ["text"],
      supported_reasoning_efforts: model.supported_reasoning_efforts.map(
        (effort) => ({ ...effort }),
      ),
    }));
    acp.onUnexpectedExit((error) => this.markFatal(error));
  }

  async run(): Promise<void> {
    if (this.configuration.approvalMode === "accept") {
      process.stderr.write(
        "警告：CLAUDE_BRIDGE_APPROVAL_MODE=accept 会自动批准与当前看板任务关联的 Claude 权限请求\n",
      );
    }
    if (this.configuration.agentMode === "bypassPermissions") {
      process.stderr.write(
        "高风险警告：CLAUDE_BRIDGE_MODE=bypass-permissions 会让 Claude Code 跳过大部分权限检查\n",
      );
    }
    process.stdout.write(`已连接 ${this.acp.agentDescription}\n`);

    const initialSessions = await this.listSessions();
    await this.discoverModelCatalog(initialSessions[0]);
    await this.establishRuntimeLease();
    if (this.stopping) return this.finishRun();
    this.leaseRenewalPromise = this.renewRuntimeLease();

    let nextInventorySyncAt = 0;
    while (!this.stopping) {
      if (this.configuration.webConfigurationEnabled) {
        try {
          const reconciled = await this.reconcileRemoteConfiguration();
          if (reconciled) {
            // The reconcile already retired excess workers through
            // syncWorkers; skip the immediate duplicate inventory pass.
            nextInventorySyncAt =
              Date.now() + this.configuration.syncIntervalMs;
          }
        } catch (error) {
          if (this.stopping) break;
          if (isPersistentClientError(error)) {
            this.markFatal(actionableBoardError(error));
            break;
          }
          process.stderr.write(
            `同步 Web Bridge 配置失败，继续使用当前有效配置：${errorMessage(error)}\n`,
          );
        }
      }
      if (this.stopping) break;
      if (Date.now() >= nextInventorySyncAt) {
        try {
          await this.syncWorkers();
          nextInventorySyncAt = Date.now() + this.configuration.syncIntervalMs;
        } catch (error) {
          if (this.stopping) break;
          if (isPersistentClientError(error)) {
            this.markFatal(actionableBoardError(error));
            break;
          }
          process.stderr.write(`同步 Claude Sessions 失败：${errorMessage(error)}\n`);
        }
      }
      if (this.stopping) break;
      try {
        if (this.inventoryReady && (await this.processThreadCommands())) {
          await this.syncWorkers();
          nextInventorySyncAt = Date.now() + this.configuration.syncIntervalMs;
        }
      } catch (error) {
        if (this.stopping) break;
        if (isPersistentClientError(error)) {
          this.markFatal(actionableBoardError(error));
          break;
        }
        process.stderr.write(`处理 Claude Session 管理指令失败：${errorMessage(error)}\n`);
      }
      if (this.inventoryReady) {
        try {
          await this.processFileCommands();
        } catch (error) {
          if (this.stopping) break;
          if (isPersistentClientError(error)) {
            this.markFatal(actionableBoardError(error));
            break;
          }
          process.stderr.write(
            `处理 Claude 文件浏览指令失败：${errorMessage(error)}\n`,
          );
        }
      }
      try {
        await delay(
          Math.min(
            this.configuration.commandPollIntervalMs,
            Math.max(1_000, nextInventorySyncAt - Date.now()),
          ),
          this.stopController.signal,
        );
      } catch {
        break;
      }
    }
    return this.finishRun();
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopBridge();
    return this.stopPromise;
  }

  private async finishRun(): Promise<void> {
    await this.stop();
    if (this.fatalError) throw this.fatalError;
  }

  private async stopBridge(): Promise<void> {
    this.stopping = true;
    this.stopController.abort(new Error("Claude Bridge 正在停止"));
    await Promise.allSettled(
      [...this.workers.values()].map((worker) => worker.stop()),
    );
    await this.acp.close();
    await Promise.allSettled([...this.workerRuns.values()]);
    await (this.leaseRenewalPromise ?? Promise.resolve()).catch(() => undefined);
    await this.releaseRuntimeLease();
  }

  private markFatal(error: Error): void {
    if (this.fatalError || this.stopping) return;
    this.fatalError = error;
    this.stopping = true;
    this.stopController.abort(error);
    for (const worker of this.workers.values()) {
      void worker.stop(error.message);
    }
  }

  private configurationStatus(releaseRuntime = false): Record<string, unknown> {
    this.reportSequence += 1;
    const firstDirectory = this.configuration.localWorkingDirectories[0];
    return {
      runtime_instance_id: this.runtimeInstanceId,
      platform: "claude",
      report_sequence: this.reportSequence,
      lease_seconds: this.configuration.runtimeLeaseSeconds,
      release_runtime: releaseRuntime,
      applied_version: this.appliedConfigurationVersion,
      effective: {
        enabled: this.configuration.enabled,
        include_thread_titles: this.configuration.includeSessionTitles,
        max_threads: this.configuration.maxThreads,
        max_concurrent_turns: this.configuration.maxConcurrentTurns,
        sync_history: false,
        history_turn_limit: this.configuration.historyTurnLimit,
        working_directories: this.configuration.workingDirectories.map(
          (directory) => ({
            directory_key: directory.key,
            name: directory.name,
            working_directory: directory.workingDirectory,
          }),
        ),
      },
      constraints: {
        remote_configuration_enabled:
          this.configuration.webConfigurationEnabled,
        allow_thread_titles: this.configuration.allowRemoteThreadTitles,
        max_threads: MAX_THREADS,
        max_concurrent_turns: MAX_CONCURRENT_TURNS,
        thread_scope: "cwd",
        working_directory: firstDirectory?.workingDirectory ?? process.cwd(),
        fixed_thread: false,
        permission_mode: "inherit",
        approval_mode:
          this.configuration.approvalMode === "accept" ? "accept" : "decline",
        allow_history_sync: false,
        max_history_turns: MAX_HISTORY_TURNS,
        allow_working_directory_configuration:
          this.configuration.allowRemoteWorkingDirectories,
      },
      error: [this.configurationError, this.updateError]
        .filter(Boolean)
        .join("；") || null,
    };
  }

  private async exchangeRuntimeLease(
    release = false,
  ): Promise<RemoteConfigurationResponse> {
    const startedAt = Date.now();
    const response = await this.board.exchangeConfiguration(
      this.configurationStatus(release),
      release ? undefined : this.stopController.signal,
      release ? 1_500 : 5_000,
    );
    if (release) {
      this.runtimeLeaseClaimed = false;
      this.leaseSafetyDeadline = 0;
      return response;
    }
    this.runtimeLeaseClaimed = true;
    this.leaseSafetyDeadline =
      startedAt + this.configuration.runtimeLeaseSeconds * 1_000 - 5_000;
    if (!this.stopping) {
      // A successful exchange may carry the Board's desired Bridge version.
      // A failed update never throws; the error is reported in the next
      // exchange's error field, and a successful one exits the process so
      // systemd restarts it on the new version.
      const updateError = await maybeApplyDesiredBridgeUpdate({
        desiredVersion: response.configuration.desired_bridge_version ?? null,
        currentVersion: CLAUDE_BRIDGE_CAPABILITY_VERSION,
      });
      if (updateError) this.updateError = updateError;
    }
    return response;
  }

  private async establishRuntimeLease(): Promise<void> {
    let attempt = 0;
    while (!this.stopping) {
      attempt += 1;
      try {
        await this.exchangeRuntimeLease();
        return;
      } catch (error) {
        if (this.stopping) return;
        if (errorStatus(error) === 409) {
          if (attempt === 1 || attempt % 10 === 0) {
            process.stderr.write(
              "同一连接的旧 Bridge 租约仍有效；Claude Bridge 等待接管\n",
            );
          }
        } else if (isPersistentClientError(error)) {
          throw actionableBoardError(error);
        } else if (attempt === 1 || attempt % 10 === 0) {
          process.stderr.write(
            `尚未取得 Claude Bridge 运行租约：${errorMessage(error)}\n`,
          );
        }
        await delay(
          Math.min(500 * 2 ** Math.min(attempt - 1, 4), 5_000),
          this.stopController.signal,
        ).catch(() => undefined);
      }
    }
  }

  private async renewRuntimeLease(): Promise<void> {
    const interval = Math.max(
      1_000,
      Math.floor((this.configuration.runtimeLeaseSeconds * 1_000) / 3),
    );
    while (!this.stopping) {
      try {
        await delay(interval, this.stopController.signal);
      } catch {
        return;
      }
      if (Date.now() >= this.leaseSafetyDeadline) {
        this.markFatal(
          new Error("Claude Bridge 运行租约已超过本地安全期限，停止所有 worker"),
        );
        return;
      }
      try {
        await this.exchangeRuntimeLease();
      } catch (error) {
        if (this.stopping) return;
        if (isPersistentClientError(error)) {
          this.markFatal(actionableBoardError(error));
          return;
        }
        process.stderr.write(
          `Claude Bridge 运行租约续租失败：${errorMessage(error)}\n`,
        );
        if (Date.now() >= this.leaseSafetyDeadline) {
          this.markFatal(
            new Error("Claude Bridge 无法在安全期限前续租", { cause: error }),
          );
          return;
        }
      }
    }
  }

  private async releaseRuntimeLease(): Promise<void> {
    if (!this.runtimeLeaseClaimed) return;
    await this.exchangeRuntimeLease(true).catch(() => undefined);
  }

  private async reconcileRemoteConfiguration(): Promise<boolean> {
    let response = await this.exchangeRuntimeLease();
    let reconciled = false;

    // A re-report can race a Web edit. Apply a few consecutive versions now;
    // any later version remains unapplied and is picked up by the next loop.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remote = response.configuration;
      if (remote.version === this.appliedConfigurationVersion) {
        return reconciled;
      }
      if (
        this.appliedConfigurationVersion !== null &&
        remote.version < this.appliedConfigurationVersion
      ) {
        this.configurationError =
          `忽略过期看板配置 version=${remote.version}；设备已应用 version=${this.appliedConfigurationVersion}`;
        process.stderr.write(`${this.configurationError}\n`);
        return reconciled;
      }

      const previous = {
        enabled: this.configuration.enabled,
        includeSessionTitles: this.configuration.includeSessionTitles,
        maxThreads: this.configuration.maxThreads,
        maxConcurrentTurns: this.configuration.maxConcurrentTurns,
        historyTurnLimit: this.configuration.historyTurnLimit,
        workingDirectories: this.configuration.workingDirectories.map(
          (directory) => ({ ...directory }),
        ),
      };
      let resolved: ResolvedClaudeRemoteConfiguration;
      try {
        resolved = resolveRemoteConfiguration(
          this.configuration,
          remote.desired,
        );
      } catch (error) {
        // Validation failures happen before any runtime state is mutated.
        this.configurationError =
          `应用 version=${remote.version} 失败：${errorMessage(error)}`;
        process.stderr.write(`${this.configurationError}\n`);
        await this.exchangeRuntimeLease().catch(() => undefined);
        throw error;
      }
      this.configuration.enabled = resolved.effective.enabled;
      this.configuration.includeSessionTitles =
        resolved.effective.includeThreadTitles;
      this.configuration.maxThreads = resolved.effective.maxThreads;
      this.configuration.maxConcurrentTurns =
        resolved.effective.maxConcurrentTurns;
      this.configuration.historyTurnLimit =
        resolved.effective.historyTurnLimit;
      this.configuration.workingDirectories =
        resolved.effective.workingDirectories.map((directory) => ({
          ...directory,
        }));
      this.limiter.resize(resolved.effective.maxConcurrentTurns);
      this.configurationError = resolved.warnings.length
        ? resolved.warnings.join("；")
        : null;
      for (const warning of resolved.warnings) {
        process.stderr.write(`Web Bridge 配置警告：${warning}\n`);
      }

      try {
        // Retire workers beyond a lowered thread cap before acknowledging
        // the applied version; the next inventory pass restores any worker
        // if the values are rolled back below.
        await this.syncWorkers();
      } catch (error) {
        this.configuration.enabled = previous.enabled;
        this.configuration.includeSessionTitles =
          previous.includeSessionTitles;
        this.configuration.maxThreads = previous.maxThreads;
        this.configuration.maxConcurrentTurns =
          previous.maxConcurrentTurns;
        this.configuration.historyTurnLimit = previous.historyTurnLimit;
        this.configuration.workingDirectories = previous.workingDirectories;
        this.limiter.resize(previous.maxConcurrentTurns);
        this.configurationError = [
          this.configurationError,
          `应用 version=${remote.version} 失败：${errorMessage(error)}`,
        ]
          .filter(Boolean)
          .join("；");
        await this.exchangeRuntimeLease().catch(() => undefined);
        throw error;
      }

      this.appliedConfigurationVersion = remote.version;
      reconciled = true;
      process.stdout.write(
        `已应用 Web Bridge 配置 version=${remote.version}：${
          this.configuration.enabled ? "已启用" : "已停用"
        }，${this.configuration.workingDirectories.length} 个工作目录，最多 ${this.configuration.maxThreads} 个 Session / ${this.configuration.maxConcurrentTurns} 个并行 turn\n`,
      );

      response = await this.exchangeRuntimeLease();
    }
    return reconciled;
  }

  private async discoverModelCatalog(session?: SessionInfo): Promise<void> {
    if (!session) {
      process.stdout.write(
        `Claude 当前没有可用于探测的 Session，使用 ${this.modelCatalog.length} 个兼容模型\n`,
      );
      return;
    }
    try {
      const options = await this.acp.resumeSession(session);
      const catalog = modelCatalogFromConfigOptions(
        options,
        this.acp.supportsImages,
      );
      if (catalog?.length) this.modelCatalog = catalog;
      this.knownModels.set(
        session.sessionId,
        this.acp.selectedValue(session.sessionId, "model"),
      );
      await this.acp.closeSession(session.sessionId).catch(() => undefined);
      process.stdout.write(`已从 Claude ACP 读取 ${this.modelCatalog.length} 个模型\n`);
    } catch (error) {
      process.stderr.write(
        `读取 Claude 模型目录失败，使用兼容目录：${errorMessage(error)}\n`,
      );
    }
  }

  private async listSessions(): Promise<SessionInfo[]> {
    const discovered = new Map<string, SessionInfo>();
    for (const directory of this.configuration.workingDirectories) {
      const sessions = await this.acp.listAllSessions(directory.workingDirectory);
      for (const session of sessions) {
        if (!directoryForWorkingDirectory(session.cwd, [directory])) continue;
        discovered.set(session.sessionId, session);
        this.createdSessions.delete(session.sessionId);
      }
    }
    for (const [sessionId, session] of this.createdSessions) {
      if (
        !discovered.has(sessionId) &&
        directoryForWorkingDirectory(
          session.cwd,
          this.configuration.workingDirectories,
        )
      ) {
        discovered.set(sessionId, session);
      }
    }
    return [...discovered.values()]
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "") ||
          left.sessionId.localeCompare(right.sessionId),
      )
      .slice(0, this.configuration.maxThreads);
  }

  private inventoryThread(session: SessionInfo): InventoryThread {
    const directory = directoryForWorkingDirectory(
      session.cwd,
      this.configuration.workingDirectories,
    );
    if (!directory) {
      throw new Error(`Claude Session ${session.sessionId} 不在工作目录白名单中`);
    }
    const fallbackName = `Claude · ${directory.name} · ${session.sessionId.slice(0, 8)}`;
    const localTitle = stringValue(session.title);
    const name = this.configuration.sessionNamePrefix
      ? `${this.configuration.sessionNamePrefix} · ${
          this.configuration.includeSessionTitles && localTitle
            ? localTitle
            : session.sessionId.slice(0, 8)
        }`
      : this.configuration.includeSessionTitles && localTitle
        ? localTitle
        : fallbackName;
    return {
      external_conversation_ref: session.sessionId,
      name: name.slice(0, 200),
      platform: "claude",
      model: this.knownModels.get(session.sessionId) ?? null,
      working_directory: session.cwd,
      directory_key: directory.key,
      capabilities: this.configuration.capabilities,
      archived: false,
    };
  }

  private async syncWorkers(): Promise<void> {
    const sessions = await this.listSessions();
    const visibleIds = new Set(sessions.map((session) => session.sessionId));
    for (const [sessionId, worker] of this.workers) {
      if (visibleIds.has(sessionId)) continue;
      await worker.stop("Claude Session 已从设备清单移除");
      this.workers.delete(sessionId);
    }

    const boardSessions = await this.board.syncSessions(
      sessions.map((session) => this.inventoryThread(session)),
      this.configuration.workingDirectories,
      this.modelCatalog,
      this.stopController.signal,
    );
    if (this.stopping) return;
    this.managedSessionIds = visibleIds;
    this.inventoryReady = true;

    for (const info of sessions) {
      const boardSession = boardSessions.get(info.sessionId);
      if (!boardSession) {
        process.stderr.write(
          `看板未返回 Claude Session ${info.sessionId} 的映射\n`,
        );
        continue;
      }
      const existing = this.workers.get(info.sessionId);
      if (boardSession.deletion_requested_at) {
        if (existing) {
          await existing.stop("Claude Session 正在等待 Web 删除指令");
          this.workers.delete(info.sessionId);
        }
        continue;
      }
      if (existing) {
        existing.update(info, boardSession);
        continue;
      }
      const worker = new SessionWorker(
        info,
        boardSession,
        this.configuration,
        this.board,
        this.acp,
        this.limiter,
        (sessionId, model) => this.knownModels.set(sessionId, model),
      );
      this.workers.set(info.sessionId, worker);
      const run = worker.start().catch((error) => {
        this.workers.delete(info.sessionId);
        if (this.stopping) return;
        if (
          errorStatus(error) === 403 &&
          (error as { code?: string } | null)?.code ===
            "SESSION_NOT_AUTHORIZED"
        ) {
          process.stderr.write(
            `Claude Session ${info.sessionId} 已被看板停用；worker 已退出\n`,
          );
        } else if (isPersistentClientError(error)) {
          this.markFatal(actionableBoardError(error));
        } else {
          process.stderr.write(
            `Claude worker ${info.sessionId} 已退出：${errorMessage(error)}\n`,
          );
        }
      });
      this.workerRuns.set(info.sessionId, run);
      void run.finally(() => this.workerRuns.delete(info.sessionId));
      process.stdout.write(`已连接 Claude Session：${info.sessionId}\n`);
    }
    process.stdout.write(
      `Claude Bridge 已同步 ${sessions.length} 个 Session，最多并行 ${this.configuration.maxConcurrentTurns} 个 turn\n`,
    );
  }

  private async processThreadCommands(): Promise<boolean> {
    let inventoryChanged = false;
    for (let processed = 0; processed < 10 && !this.stopping; processed += 1) {
      const command = await this.board.claimThreadCommand(
        this.runtimeInstanceId,
        this.stopController.signal,
      );
      if (!command) break;
      try {
        const externalThreadId = await this.executeThreadCommand(command);
        await this.board.completeThreadCommand(
          this.runtimeInstanceId,
          command.id,
          { succeeded: true, externalThreadId },
          this.stopController.signal,
        );
        inventoryChanged = true;
        process.stdout.write(
          `Web Claude Session 指令已完成：${command.action} (${externalThreadId ?? command.id})\n`,
        );
      } catch (error) {
        if (this.stopping) throw error;
        const message = commandError(error);
        await this.board.completeThreadCommand(
          this.runtimeInstanceId,
          command.id,
          { succeeded: false, error: message },
          this.stopController.signal,
        );
        process.stderr.write(
          `Web Claude Session 指令 ${command.action} 失败：${message}\n`,
        );
      }
    }
    return inventoryChanged;
  }

  private async processFileCommands(): Promise<void> {
    for (let processed = 0; processed < 10 && !this.stopping; processed += 1) {
      const command = await this.board.claimFileCommand(
        this.runtimeInstanceId,
        this.stopController.signal,
      );
      if (!command) break;
      try {
        const result = await this.executeFileCommand(command);
        await this.board.completeFileCommand(
          this.runtimeInstanceId,
          command.id,
          { succeeded: true, result },
          this.stopController.signal,
        );
      } catch (error) {
        if (this.stopping) throw error;
        const message = commandError(error);
        await this.board.completeFileCommand(
          this.runtimeInstanceId,
          command.id,
          { succeeded: false, error: message },
          this.stopController.signal,
        );
        process.stderr.write(
          `Web Claude 文件指令 ${command.action} 失败：${message}\n`,
        );
      }
    }
  }

  private async executeFileCommand(
    command: FileCommand,
  ): Promise<DeviceFileListResult | DeviceFilePreviewResult> {
    if (command.action === "list") {
      return listDeviceDirectory(
        this.configuration.workingDirectories,
        command.path,
      );
    }
    return readDeviceFilePreview(
      this.configuration.workingDirectories,
      command.path,
    );
  }

  private async executeThreadCommand(
    command: ThreadCommand,
  ): Promise<string | null> {
    if (command.action === "create") {
      if (!this.configuration.enabled) {
        throw new Error("Claude Bridge 已暂停，无法新建 Session");
      }
      if (this.managedSessionIds.size >= this.configuration.maxThreads) {
        throw new Error("已达到 Claude Bridge 的 Session 数量上限");
      }
      const name = commandString(command.name);
      if (!name) throw new Error("新建 Claude Session 指令缺少名称");
      const cwd = workingDirectoryForKey(
        command.directory_key,
        this.configuration.workingDirectories,
      );
      const created = await this.acp.newSession(cwd);
      const info: SessionInfo = {
        sessionId: created.sessionId,
        cwd: path.resolve(cwd),
        title: name,
        updatedAt: new Date().toISOString(),
      };
      try {
        await prepareClaudeSession(
          this.acp,
          info,
          this.configuration,
          commandString(command.model),
          commandString(command.reasoning_effort),
          created.configOptions,
        );
      } catch (error) {
        await this.acp.deleteSession(created.sessionId).catch((deleteError) => {
          process.stderr.write(
            `回滚新建 Claude Session ${created.sessionId} 失败：${errorMessage(deleteError)}\n`,
          );
        });
        throw error;
      }
      this.knownModels.set(
        created.sessionId,
        this.acp.selectedValue(created.sessionId, "model"),
      );
      await this.acp.closeSession(created.sessionId).catch(() => undefined);
      this.createdSessions.set(created.sessionId, info);
      this.managedSessionIds.add(created.sessionId);
      return created.sessionId;
    }

    const sessionId = commandString(command.external_thread_id);
    if (!sessionId) throw new Error("Claude Session 指令缺少目标 ID");
    if (command.action === "rename") {
      throw new Error("当前 Claude ACP 不提供 Session 改名能力");
    }
    const managed = this.managedSessionIds.has(sessionId);
    if (!managed && (command.attempt_count ?? 1) > 1) return sessionId;
    if (!managed) throw new Error("目标 Claude Session 不在受管清单中");
    const worker = this.workers.get(sessionId);
    if (worker?.busy) throw new Error("Claude Session 正在执行任务，暂时不能删除");
    if (worker) {
      await worker.stop("用户从 Web Console 删除了 Claude Session");
      this.workers.delete(sessionId);
    }
    await this.acp.deleteSession(sessionId);
    this.createdSessions.delete(sessionId);
    this.knownModels.delete(sessionId);
    this.managedSessionIds.delete(sessionId);
    return sessionId;
  }
}

export async function runBridgeCli(): Promise<void> {
  const configuration = loadConfiguration();
  const acp = await ClaudeAcpClient.start(configuration);
  const bridge = new ClaudeBridge(configuration, acp);
  const stop = () => void bridge.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await bridge.run();
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await bridge.stop();
  }
}

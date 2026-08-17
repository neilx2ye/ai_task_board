import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AGY_STREAM_PROTOCOL,
  ANTIGRAVITY_FALLBACK_MODEL_CATALOG,
  AgyClient,
  type AgyPromptResult,
  type InventoryModel,
} from "./agy-client.js";
import {
  actionableBoardError,
  ANTIGRAVITY_BRIDGE_CAPABILITY_VERSION,
  BoardClient,
  commandError,
  commandString,
  type BoardSession,
  type ClaimedTask,
  type InventoryThread,
  type RemoteConfigurationResponse,
  type RemoteDesiredConfiguration,
  type ThreadCommand,
} from "./board-client.js";
import {
  directoryForWorkingDirectory,
  loadConfiguration,
  parseRemoteWorkingDirectories,
  workingDirectoryForKey,
  type AntigravityBridgeConfiguration,
  type ManagedWorkingDirectory,
} from "./config.js";
import { fetchAntigravityQuota, type SyncedQuota } from "./quota.js";
import { BridgeRegistry } from "./registry.js";
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

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
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

export type ResolvedAntigravityRemoteConfiguration = {
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
  configuration: AntigravityBridgeConfiguration,
  desired: RemoteDesiredConfiguration,
): ResolvedAntigravityRemoteConfiguration {
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
  if (desired.sync_history) {
    warnings.push(
      "Antigravity Bridge 不支持历史同步，忽略看板的历史同步请求",
    );
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
        "看板请求配置工作目录，但设备未启用 ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION；继续使用本机启动目录",
      );
    }
  }
  return {
    effective: {
      enabled: desired.enabled,
      // Antigravity always uploads titles, so Web can only reduce exposure.
      includeThreadTitles: desired.include_thread_titles,
      maxThreads: clampedRemoteInteger(
        desired.max_threads,
        configuration.localMaxThreads,
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

export type ManagedThread = {
  bindingId: string;
  conversationId: string | null;
  workingDirectory: string;
  directoryKey: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

class TurnRecorder {
  assistant = "";
  toolCalls = 0;
  failedToolCalls = 0;
  checkpoints = 0;

  consumeDelta(text: string): void {
    this.assistant = appendBoundedText(this.assistant, text);
  }

  resultData(
    result: AgyPromptResult,
    model: string | null,
    reasoningEffort: string | null,
  ): Record<string, unknown> {
    return {
      protocol: AGY_STREAM_PROTOCOL,
      phase: "completed",
      status: result.status,
      model,
      reasoning_effort: reasoningEffort,
      conversation_id: result.conversationId,
      duration_seconds: result.durationSeconds,
      num_turns: result.numTurns,
      tool_call_count: this.toolCalls,
      failed_tool_call_count: this.failedToolCalls,
      checkpoint_count: this.checkpoints,
      usage: sanitizeValue(result.usage),
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
    private thread: ManagedThread,
    private boardSession: BoardSession,
    private readonly configuration: AntigravityBridgeConfiguration,
    private readonly board: BoardClient,
    private readonly agy: AgyClient,
    private readonly registry: BridgeRegistry,
    private readonly limiter: TurnLimiter,
    private readonly onModelChanged: (
      bindingId: string,
      model: string | null,
    ) => void,
  ) {}

  get bindingId(): string {
    return this.thread.bindingId;
  }

  get busy(): boolean {
    return this.activeClaim !== null || this.activePrompt;
  }

  update(thread: ManagedThread, boardSession: BoardSession): void {
    this.thread = thread;
    this.boardSession = boardSession;
  }

  start(): Promise<void> {
    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }

  async stop(reason = "Antigravity Bridge 正在停止"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopController.abort(new Error(reason));
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
              `Antigravity Thread ${this.thread.bindingId} 心跳失败：${errorMessage(error)}\n`,
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
            "Antigravity Bridge 已停止",
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
        `开始 Antigravity 任务 [${this.thread.bindingId.slice(0, 8)}]：${task.title}\n`,
      );
      try {
        await this.executeTask(task);
        process.stdout.write(
          `完成 Antigravity 任务 [${this.thread.bindingId.slice(0, 8)}]：${task.title}\n`,
        );
      } catch (error) {
        if (this.stopping) {
          await this.board
            .releaseTask(
              this.boardSession.id,
              task,
              "Antigravity Bridge 正在停止",
            )
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
            `Antigravity 任务失败 [${this.thread.bindingId}]：${reason}\n`,
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
    if (task.goal_mode === true || task.goal_mode === false) {
      throw new Error(
        "Antigravity CLI 没有公开的 goal 控制接口，无法执行 Goal 模式任务",
      );
    }
    const model = stringValue(task.model);
    const reasoningEffort = stringValue(task.reasoning_effort);
    this.onModelChanged(this.thread.bindingId, model);

    const text = [
      task.description?.trim() || task.title,
      task.acceptance_criteria
        ? `\n\n验收条件：\n${task.acceptance_criteria}`
        : "",
    ].join("");
    const artifacts = await this.board.taskArtifacts(
      this.boardSession.id,
      task.id,
      this.stopController.signal,
    );
    const images = artifacts.filter((artifact) =>
      IMAGE_MIME_TYPES.has(artifact.mime_type),
    );
    if (images.length > 0) {
      throw new Error("Antigravity CLI headless 模式不支持图片输入");
    }

    const recorder = new TurnRecorder();
    let learnedConversationId = this.thread.conversationId;
    this.activePrompt = true;
    let result: AgyPromptResult;
    try {
      result = await this.agy.prompt({
        cwd: this.thread.workingDirectory,
        prompt: text,
        conversationId: this.thread.conversationId,
        model,
        reasoningEffort,
        signal: this.stopController.signal,
        onTextDelta: (delta) => recorder.consumeDelta(delta),
        onConversationId: (conversationId) => {
          learnedConversationId = conversationId;
        },
      });
    } finally {
      this.activePrompt = false;
    }

    if (result.status === "CANCELED" || result.status === "INTERRUPTED") {
      throw new Error(`Antigravity 本轮任务已${result.status === "CANCELED" ? "取消" : "中断"}`);
    }
    if (result.status === "WAITING") {
      throw new Error("Antigravity 本轮任务结束于等待输入状态");
    }
    if (result.status !== "SUCCESS") {
      throw new Error(`Antigravity 本轮任务异常结束（${result.status}）`);
    }

    recorder.toolCalls = result.toolCallCount;
    recorder.failedToolCalls = result.failedToolCallCount;
    recorder.checkpoints = result.checkpointCount;

    if (learnedConversationId && learnedConversationId !== this.thread.conversationId) {
      this.thread.conversationId = learnedConversationId;
      this.thread.updatedAt = new Date().toISOString();
      this.thread.model = model;
      await this.registry.upsert(this.thread.bindingId, {
        conversationId: learnedConversationId,
        directoryKey: this.thread.directoryKey,
        workingDirectory: this.thread.workingDirectory,
        name: this.thread.title,
        model,
        createdAt: this.thread.createdAt,
        updatedAt: this.thread.updatedAt,
      }).catch(() => undefined);
    }

    const resultData = recorder.resultData(result, model, reasoningEffort);
    const response = recorder.assistant || result.response;
    if (response) {
      await this.board.reportAssistantMessage(
        this.boardSession.id,
        this.thread.bindingId,
        task,
        response,
        resultData,
        this.stopController.signal,
      );
    }
    await this.board.completeTask(
      this.boardSession.id,
      task,
      response || `Antigravity 已结束本轮（${result.status}）`,
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

export class AntigravityBridge {
  private readonly stopController = new AbortController();
  private readonly board: BoardClient;
  private readonly limiter: TurnLimiter;
  private readonly runtimeInstanceId = randomUUID();
  private readonly workers = new Map<string, SessionWorker>();
  private readonly workerRuns = new Map<string, Promise<void>>();
  private readonly knownModels = new Map<string, string | null>();
  private managedThreadIds = new Set<string>();
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
  private quota: SyncedQuota | undefined;

  constructor(
    private readonly configuration: AntigravityBridgeConfiguration,
    private readonly agy: AgyClient,
    private readonly registry: BridgeRegistry,
  ) {
    this.board = new BoardClient(configuration, () => this.stopping);
    this.limiter = new TurnLimiter(configuration.maxConcurrentTurns);
    this.modelCatalog = ANTIGRAVITY_FALLBACK_MODEL_CATALOG.map((model) => ({
      ...model,
      supported_reasoning_efforts: model.supported_reasoning_efforts.map(
        (effort) => ({ ...effort }),
      ),
    }));
  }

  async run(): Promise<void> {
    if (this.configuration.approvalMode === "accept") {
      process.stderr.write(
        "警告：ANTIGRAVITY_BRIDGE_APPROVAL_MODE=accept 会向 agy 传入 --dangerously-skip-permissions，自动批准所有工具调用\n",
      );
    }
    if (this.configuration.sandbox) {
      process.stdout.write("Antigravity Bridge 已启用 agy 终端沙箱\n");
    }
    await this.agy.ensureSupportedVersion();
    process.stdout.write(
      `已检测 Antigravity CLI ${await this.agy.version()}，使用官方 headless stream-json 接口\n`,
    );

    await this.discoverModelCatalog();
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
          process.stderr.write(
            `同步 Antigravity Threads 失败：${errorMessage(error)}\n`,
          );
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
        process.stderr.write(
          `处理 Antigravity Thread 管理指令失败：${errorMessage(error)}\n`,
        );
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
    this.stopController.abort(new Error("Antigravity Bridge 正在停止"));
    await Promise.allSettled(
      [...this.workers.values()].map((worker) => worker.stop()),
    );
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
        allow_thread_titles: true,
        max_threads: this.configuration.localMaxThreads,
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
        desiredVersion:
          response.configuration.desired_bridge_version ?? null,
        currentVersion: ANTIGRAVITY_BRIDGE_CAPABILITY_VERSION,
        allowRemoteUpdate: this.configuration.allowRemoteUpdate,
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
              "同一连接的旧 Bridge 租约仍有效；Antigravity Bridge 等待接管\n",
            );
          }
        } else if (isPersistentClientError(error)) {
          throw actionableBoardError(error);
        } else if (attempt === 1 || attempt % 10 === 0) {
          process.stderr.write(
            `尚未取得 Antigravity Bridge 运行租约：${errorMessage(error)}\n`,
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
          new Error("Antigravity Bridge 运行租约已超过本地安全期限，停止所有 worker"),
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
          `Antigravity Bridge 运行租约续租失败：${errorMessage(error)}\n`,
        );
        if (Date.now() >= this.leaseSafetyDeadline) {
          this.markFatal(
            new Error("Antigravity Bridge 无法在安全期限前续租", { cause: error }),
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
      let resolved: ResolvedAntigravityRemoteConfiguration;
      try {
        resolved = resolveRemoteConfiguration(
          this.configuration,
          remote.desired,
        );
      } catch (error) {
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
        }，${this.configuration.workingDirectories.length} 个工作目录，最多 ${this.configuration.maxThreads} 个 Thread / ${this.configuration.maxConcurrentTurns} 个并行 turn\n`,
      );

      response = await this.exchangeRuntimeLease();
    }
    return reconciled;
  }

  private async discoverModelCatalog(): Promise<void> {
    try {
      const catalog = await this.agy.modelCatalog();
      if (catalog.length) this.modelCatalog = catalog;
      process.stdout.write(
        `已从 agy models 读取 ${this.modelCatalog.length} 个模型\n`,
      );
    } catch (error) {
      process.stderr.write(
        `读取 agy 模型目录失败，使用兼容目录：${errorMessage(error)}\n`,
      );
    }
  }

  private async listThreads(): Promise<ManagedThread[]> {
    const bindings = await this.registry.list();
    const discovered: ManagedThread[] = [];
    for (const [bindingId, binding] of bindings) {
      if (!directoryForWorkingDirectory(
        binding.workingDirectory,
        this.configuration.workingDirectories,
      )) {
        continue;
      }
      discovered.push({
        bindingId,
        conversationId: binding.conversationId,
        workingDirectory: binding.workingDirectory,
        directoryKey: binding.directoryKey,
        title: binding.name,
        model: binding.model,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
    }
    return discovered
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          left.bindingId.localeCompare(right.bindingId),
      )
      .slice(0, this.configuration.maxThreads);
  }

  private inventoryThread(thread: ManagedThread): InventoryThread {
    const directory = directoryForWorkingDirectory(
      thread.workingDirectory,
      this.configuration.workingDirectories,
    );
    if (!directory) {
      throw new Error(
        `Antigravity Thread ${thread.bindingId} 不在工作目录白名单中`,
      );
    }
    const fallbackName = `Antigravity · ${directory.name} · ${thread.bindingId.slice(0, 8)}`;
    const name = this.configuration.sessionNamePrefix
      ? `${this.configuration.sessionNamePrefix} · ${
          this.configuration.includeSessionTitles && thread.title
            ? thread.title
            : thread.bindingId.slice(0, 8)
        }`
      : this.configuration.includeSessionTitles && thread.title
        ? thread.title
        : fallbackName;
    return {
      external_conversation_ref: thread.bindingId,
      name: name.slice(0, 200),
      platform: "antigravity",
      model: this.knownModels.get(thread.bindingId) ?? thread.model,
      working_directory: thread.workingDirectory,
      directory_key: directory.key,
      capabilities: this.configuration.capabilities,
      archived: false,
    };
  }

  private async syncWorkers(): Promise<void> {
    const threads = await this.listThreads();
    const visibleIds = new Set(threads.map((thread) => thread.bindingId));
    for (const [bindingId, worker] of this.workers) {
      if (visibleIds.has(bindingId)) continue;
      await worker.stop("Antigravity Thread 已从本地注册表移除");
      this.workers.delete(bindingId);
    }

    const boardSessions = await this.board.syncSessions(
      threads.map((thread) => this.inventoryThread(thread)),
      this.configuration.workingDirectories,
      this.modelCatalog,
      this.quota,
      this.stopController.signal,
    );
    if (this.stopping) return;
    void this.refreshQuota();
    this.managedThreadIds = visibleIds;
    this.inventoryReady = true;

    for (const thread of threads) {
      const boardSession = boardSessions.get(thread.bindingId);
      if (!boardSession) {
        process.stderr.write(
          `看板未返回 Antigravity Thread ${thread.bindingId} 的映射\n`,
        );
        continue;
      }
      const existing = this.workers.get(thread.bindingId);
      if (boardSession.deletion_requested_at) {
        if (existing) {
          await existing.stop("Antigravity Thread 正在等待 Web 删除指令");
          this.workers.delete(thread.bindingId);
        }
        continue;
      }
      if (existing) {
        existing.update(thread, boardSession);
        continue;
      }
      const worker = new SessionWorker(
        thread,
        boardSession,
        this.configuration,
        this.board,
        this.agy,
        this.registry,
        this.limiter,
        (bindingId, model) => this.knownModels.set(bindingId, model),
      );
      this.workers.set(thread.bindingId, worker);
      const run = worker.start().catch((error) => {
        this.workers.delete(thread.bindingId);
        if (this.stopping) return;
        if (
          errorStatus(error) === 403 &&
          (error as { code?: string } | null)?.code === "SESSION_NOT_AUTHORIZED"
        ) {
          process.stderr.write(
            `Antigravity Thread ${thread.bindingId} 已被看板停用；worker 已退出\n`,
          );
        } else if (isPersistentClientError(error)) {
          this.markFatal(actionableBoardError(error));
        } else {
          process.stderr.write(
            `Antigravity worker ${thread.bindingId} 已退出：${errorMessage(error)}\n`,
          );
        }
      });
      this.workerRuns.set(thread.bindingId, run);
      void run.finally(() => this.workerRuns.delete(thread.bindingId));
      process.stdout.write(`已连接 Antigravity Thread：${thread.bindingId}\n`);
    }
    process.stdout.write(
      `Antigravity Bridge 已同步 ${threads.length} 个 Thread，最多并行 ${this.configuration.maxConcurrentTurns} 个 turn\n`,
    );
  }

  private async refreshQuota(): Promise<void> {
    try {
      const quota = await fetchAntigravityQuota({
        stateDir: this.configuration.stateDir,
        codeAssistBaseUrl: this.configuration.codeAssistBaseUrl,
        agyBinary: this.configuration.agyBinary,
        signal: this.stopController.signal,
      });
      if (!this.stopping) this.quota = quota;
    } catch (error) {
      process.stderr.write(
        `读取 Antigravity 额度失败：${errorMessage(error)}\n`,
      );
      this.quota = {
        provider: "antigravity",
        status: "error",
        message: errorMessage(error),
        account: null,
        plan: null,
        fetched_at: new Date().toISOString(),
        buckets: [],
        credits: null,
      };
    }
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
          `Web Antigravity Thread 指令已完成：${command.action} (${externalThreadId ?? command.id})\n`,
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
          `Web Antigravity Thread 指令 ${command.action} 失败：${message}\n`,
        );
      }
    }
    return inventoryChanged;
  }

  private async executeThreadCommand(
    command: ThreadCommand,
  ): Promise<string | null> {
    if (command.action === "create") {
      if (!this.configuration.enabled) {
        throw new Error("Antigravity Bridge 已暂停，无法新建 Thread");
      }
      if (this.managedThreadIds.size >= this.configuration.maxThreads) {
        throw new Error("已达到 Antigravity Bridge 的 Thread 数量上限");
      }
      const name = commandString(command.name);
      if (!name) throw new Error("新建 Antigravity Thread 指令缺少名称");
      const cwd = workingDirectoryForKey(
        command.directory_key,
        this.configuration.workingDirectories,
      );
      const directory = directoryForWorkingDirectory(
        cwd,
        this.configuration.workingDirectories,
      );
      if (!directory) {
        throw new Error("新建 Antigravity Thread 的工作目录不在白名单中");
      }
      const bindingId = randomUUID();
      const now = new Date().toISOString();
      await this.registry.upsert(bindingId, {
        conversationId: null,
        directoryKey: directory.key,
        workingDirectory: path.resolve(cwd),
        name,
        model: stringValue(command.model),
        createdAt: now,
        updatedAt: now,
      });
      this.managedThreadIds.add(bindingId);
      this.knownModels.set(bindingId, stringValue(command.model));
      return bindingId;
    }

    const bindingId = commandString(command.external_thread_id);
    if (!bindingId) throw new Error("Antigravity Thread 指令缺少目标 ID");
    if (command.action === "rename") {
      throw new Error("Antigravity CLI 没有可靠的 headless 改名能力");
    }
    const managed = this.managedThreadIds.has(bindingId);
    if (!managed && (command.attempt_count ?? 1) > 1) return bindingId;
    if (!managed) throw new Error("目标 Antigravity Thread 不在受管清单中");
    const worker = this.workers.get(bindingId);
    if (worker?.busy) {
      throw new Error("Antigravity Thread 正在执行任务，暂时不能删除");
    }
    if (worker) {
      await worker.stop("用户从 Web Console 删除了 Antigravity Thread");
      this.workers.delete(bindingId);
    }
    // Only the Bridge-side binding is removed. The real agy conversation is
    // intentionally preserved on disk so local history stays intact.
    await this.registry.delete(bindingId);
    this.knownModels.delete(bindingId);
    this.managedThreadIds.delete(bindingId);
    return bindingId;
  }
}

export async function runBridgeCli(): Promise<void> {
  const configuration = loadConfiguration();
  const agy = new AgyClient(configuration);
  const registry = new BridgeRegistry(configuration.registryFile);
  const bridge = new AntigravityBridge(configuration, agy, registry);
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

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
  KIMI_FALLBACK_MODEL_CATALOG,
  KimiAcpClient,
  modelCatalogFromConfigOptions,
  type InventoryModel,
} from "./acp-client.js";
import {
  actionableBoardError,
  BoardClient,
  commandError,
  commandString,
  type BoardSession,
  type ClaimedTask,
  type InventoryThread,
  type ThreadCommand,
} from "./board-client.js";
import {
  directoryForWorkingDirectory,
  loadConfiguration,
  workingDirectoryForKey,
  type KimiBridgeConfiguration,
} from "./config.js";
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

const ACP_PROTOCOL = "kimi-acp/v1";
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export class TurnLimiter {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("TurnLimiter limit 必须是正整数");
    }
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

type PreparedSession = {
  options: SessionConfigOption[];
  model: string | null;
  reasoningEffort: string | null;
};

export async function prepareKimiSession(
  acp: KimiAcpClient,
  session: SessionInfo,
  configuration: Pick<KimiBridgeConfiguration, "agentMode">,
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
    private readonly configuration: KimiBridgeConfiguration,
    private readonly board: BoardClient,
    private readonly acp: KimiAcpClient,
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

  async stop(reason = "Kimi Bridge 正在停止"): Promise<void> {
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
              `Kimi Session ${this.info.sessionId} 心跳失败：${errorMessage(error)}\n`,
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
            "Kimi Bridge 已停止",
          )
          .catch(() => undefined);
        this.activeClaim = null;
      }
    }
  }

  private async runOneIteration(): Promise<void> {
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
        `开始 Kimi 任务 [${this.info.sessionId.slice(0, 8)}]：${task.title}\n`,
      );
      try {
        await this.executeTask(task);
        process.stdout.write(
          `完成 Kimi 任务 [${this.info.sessionId.slice(0, 8)}]：${task.title}\n`,
        );
      } catch (error) {
        if (this.stopping) {
          await this.board
            .releaseTask(this.boardSession.id, task, "Kimi Bridge 正在停止")
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
            `Kimi 任务失败 [${this.info.sessionId}]：${reason}\n`,
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
    const prepared = await prepareKimiSession(
      this.acp,
      this.info,
      this.configuration,
      stringValue(task.model),
      stringValue(task.reasoning_effort),
    );
    this.onModelChanged(this.info.sessionId, prepared.model);

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
    if (images.length > 0 && !this.acp.supportsImages) {
      throw new Error("当前 Kimi Code ACP 不支持图片输入");
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
    let response: Awaited<ReturnType<KimiAcpClient["prompt"]>>;
    try {
      response = await this.acp.prompt(this.info.sessionId, task.id, prompt);
    } finally {
      this.activePrompt = false;
      this.acp.setTaskActive(this.info.sessionId, false);
      unsubscribe();
      await this.acp.closeSession(this.info.sessionId).catch(() => undefined);
    }

    if (response.stopReason === "refusal") {
      throw new Error("Kimi 拒绝执行本轮任务");
    }
    if (response.stopReason === "cancelled") {
      throw new Error("Kimi 本轮任务已取消");
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
      recorder.assistant || `Kimi Code 已结束本轮（${response.stopReason}）`,
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

export class KimiBridge {
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
  private runtimeLeaseClaimed = false;
  private leaseSafetyDeadline = 0;
  private leaseRenewalPromise: Promise<void> | null = null;
  private stopping = false;
  private fatalError: Error | null = null;
  private stopPromise: Promise<void> | null = null;
  private inventoryReady = false;

  constructor(
    private readonly configuration: KimiBridgeConfiguration,
    private readonly acp: KimiAcpClient,
  ) {
    this.board = new BoardClient(configuration, () => this.stopping);
    this.limiter = new TurnLimiter(configuration.maxConcurrentTurns);
    this.modelCatalog = KIMI_FALLBACK_MODEL_CATALOG.map((model) => ({
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
        "警告：KIMI_BRIDGE_APPROVAL_MODE=accept 会自动批准与当前看板任务关联的 Kimi 权限请求\n",
      );
    }
    if (this.configuration.agentMode === "yolo") {
      process.stderr.write(
        "高风险警告：KIMI_BRIDGE_MODE=yolo 会让 Kimi Code 自动执行所有工具操作\n",
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
          process.stderr.write(`同步 Kimi Sessions 失败：${errorMessage(error)}\n`);
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
        process.stderr.write(`处理 Kimi Session 管理指令失败：${errorMessage(error)}\n`);
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
    this.stopController.abort(new Error("Kimi Bridge 正在停止"));
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
    const firstDirectory = this.configuration.workingDirectories[0];
    return {
      runtime_instance_id: this.runtimeInstanceId,
      report_sequence: this.reportSequence,
      lease_seconds: this.configuration.runtimeLeaseSeconds,
      release_runtime: releaseRuntime,
      applied_version: null,
      effective: {
        enabled: true,
        include_thread_titles: this.configuration.includeSessionTitles,
        max_threads: this.configuration.maxThreads,
        max_concurrent_turns: this.configuration.maxConcurrentTurns,
        sync_history: false,
        history_turn_limit: 1,
        working_directories: this.configuration.workingDirectories.map(
          (directory) => ({
            directory_key: directory.key,
            name: directory.name,
            working_directory: directory.workingDirectory,
          }),
        ),
      },
      constraints: {
        remote_configuration_enabled: false,
        allow_thread_titles: this.configuration.includeSessionTitles,
        max_threads: this.configuration.maxThreads,
        max_concurrent_turns: this.configuration.maxConcurrentTurns,
        thread_scope: "cwd",
        working_directory: firstDirectory?.workingDirectory ?? process.cwd(),
        fixed_thread: false,
        permission_mode: "inherit",
        approval_mode:
          this.configuration.approvalMode === "accept" ? "accept" : "decline",
        allow_history_sync: false,
        max_history_turns: 1,
        allow_working_directory_configuration: false,
      },
      error: null,
    };
  }

  private async exchangeRuntimeLease(release = false): Promise<void> {
    const startedAt = Date.now();
    await this.board.exchangeConfiguration(
      this.configurationStatus(release),
      release ? undefined : this.stopController.signal,
      release ? 1_500 : 5_000,
    );
    if (release) {
      this.runtimeLeaseClaimed = false;
      this.leaseSafetyDeadline = 0;
      return;
    }
    this.runtimeLeaseClaimed = true;
    this.leaseSafetyDeadline =
      startedAt + this.configuration.runtimeLeaseSeconds * 1_000 - 5_000;
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
              "同一连接的旧 Bridge 租约仍有效；Kimi Bridge 等待接管\n",
            );
          }
        } else if (isPersistentClientError(error)) {
          throw actionableBoardError(error);
        } else if (attempt === 1 || attempt % 10 === 0) {
          process.stderr.write(
            `尚未取得 Kimi Bridge 运行租约：${errorMessage(error)}\n`,
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
          new Error("Kimi Bridge 运行租约已超过本地安全期限，停止所有 worker"),
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
          `Kimi Bridge 运行租约续租失败：${errorMessage(error)}\n`,
        );
        if (Date.now() >= this.leaseSafetyDeadline) {
          this.markFatal(
            new Error("Kimi Bridge 无法在安全期限前续租", { cause: error }),
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

  private async discoverModelCatalog(session?: SessionInfo): Promise<void> {
    if (!session) {
      process.stdout.write(
        `Kimi 当前没有可用于探测的 Session，使用 ${this.modelCatalog.length} 个兼容模型\n`,
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
      process.stdout.write(`已从 Kimi ACP 读取 ${this.modelCatalog.length} 个模型\n`);
    } catch (error) {
      process.stderr.write(
        `读取 Kimi 模型目录失败，使用兼容目录：${errorMessage(error)}\n`,
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
      throw new Error(`Kimi Session ${session.sessionId} 不在工作目录白名单中`);
    }
    const fallbackName = `Kimi · ${directory.name} · ${session.sessionId.slice(0, 8)}`;
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
      platform: "kimi-code",
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
      await worker.stop("Kimi Session 已从设备清单移除");
      this.workers.delete(sessionId);
    }

    const boardSessions = await this.board.syncSessions(
      sessions.map((session) => this.inventoryThread(session)),
      this.configuration.workingDirectories,
      this.modelCatalog,
      this.stopController.signal,
    );
    this.managedSessionIds = visibleIds;
    this.inventoryReady = true;

    for (const info of sessions) {
      const boardSession = boardSessions.get(info.sessionId);
      if (!boardSession) {
        process.stderr.write(
          `看板未返回 Kimi Session ${info.sessionId} 的映射\n`,
        );
        continue;
      }
      const existing = this.workers.get(info.sessionId);
      if (boardSession.deletion_requested_at) {
        if (existing) {
          await existing.stop("Kimi Session 正在等待 Web 删除指令");
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
            `Kimi Session ${info.sessionId} 已被看板停用；worker 已退出\n`,
          );
        } else if (isPersistentClientError(error)) {
          this.markFatal(actionableBoardError(error));
        } else {
          process.stderr.write(
            `Kimi worker ${info.sessionId} 已退出：${errorMessage(error)}\n`,
          );
        }
      });
      this.workerRuns.set(info.sessionId, run);
      void run.finally(() => this.workerRuns.delete(info.sessionId));
      process.stdout.write(`已连接 Kimi Session：${info.sessionId}\n`);
    }
    process.stdout.write(
      `Kimi Bridge 已同步 ${sessions.length} 个 Session，最多并行 ${this.configuration.maxConcurrentTurns} 个 turn\n`,
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
          `Web Kimi Session 指令已完成：${command.action} (${externalThreadId ?? command.id})\n`,
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
          `Web Kimi Session 指令 ${command.action} 失败：${message}\n`,
        );
      }
    }
    return inventoryChanged;
  }

  private async executeThreadCommand(
    command: ThreadCommand,
  ): Promise<string | null> {
    if (command.action === "create") {
      if (this.managedSessionIds.size >= this.configuration.maxThreads) {
        throw new Error("已达到 Kimi Bridge 的 Session 数量上限");
      }
      const name = commandString(command.name);
      if (!name) throw new Error("新建 Kimi Session 指令缺少名称");
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
        await prepareKimiSession(
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
            `回滚新建 Kimi Session ${created.sessionId} 失败：${errorMessage(deleteError)}\n`,
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
    if (!sessionId) throw new Error("Kimi Session 指令缺少目标 ID");
    if (command.action === "rename") {
      throw new Error("当前 Kimi ACP 不提供 Session 改名能力");
    }
    const managed = this.managedSessionIds.has(sessionId);
    if (!managed && (command.attempt_count ?? 1) > 1) return sessionId;
    if (!managed) throw new Error("目标 Kimi Session 不在受管清单中");
    const worker = this.workers.get(sessionId);
    if (worker?.busy) throw new Error("Kimi Session 正在执行任务，暂时不能删除");
    if (worker) {
      await worker.stop("用户从 Web Console 删除了 Kimi Session");
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
  const acp = await KimiAcpClient.start(configuration);
  const bridge = new KimiBridge(configuration, acp);
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

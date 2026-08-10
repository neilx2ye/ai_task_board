import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export type AppServerRequestId = string | number;

export interface AppServerClientInfo {
  name: string;
  title?: string | null;
  version: string;
}

export interface AppServerInitializeCapabilities {
  experimentalApi?: boolean;
  requestAttestation?: boolean;
  mcpServerOpenaiFormElicitation?: boolean;
  optOutNotificationMethods?: string[] | null;
  extensions?: Record<string, unknown> | null;
}

export interface AppServerInitializeParams {
  clientInfo: AppServerClientInfo;
  capabilities?: AppServerInitializeCapabilities | null;
}

export interface AppServerInitializeResponse {
  userAgent: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
  [key: string]: unknown;
}

export interface AppServerThread {
  id: string;
  source?: unknown;
  /** Unix timestamp in seconds. */
  createdAt?: number | null;
  /** Unix timestamp in seconds; changes when a turn mutates the thread. */
  updatedAt?: number | null;
  [key: string]: unknown;
}

export type AppServerSortDirection = "asc" | "desc";
export type AppServerTurnItemsView = "notLoaded" | "summary" | "full";

export interface AppServerThreadItem {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface AppServerTurn {
  id: string;
  items?: AppServerThreadItem[];
  itemsView?: AppServerTurnItemsView;
  status?: "completed" | "interrupted" | "failed" | "inProgress" | string;
  error?: unknown;
  /** Unix timestamp in seconds. */
  startedAt?: number | null;
  /** Unix timestamp in seconds. */
  completedAt?: number | null;
  [key: string]: unknown;
}

export interface AppServerUserInput {
  type: string;
  [key: string]: unknown;
}

export interface AppServerThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  [key: string]: unknown;
}

export interface AppServerThreadListResponse {
  data: AppServerThread[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
  [key: string]: unknown;
}

export interface AppServerThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
  [key: string]: unknown;
}

export interface AppServerThreadReadResponse {
  thread: AppServerThread & { turns?: AppServerTurn[] };
  [key: string]: unknown;
}

export interface AppServerThreadTurnsListParams {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: AppServerSortDirection | null;
  itemsView?: AppServerTurnItemsView | null;
  [key: string]: unknown;
}

export interface AppServerThreadTurnsListResponse {
  data: AppServerTurn[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
  [key: string]: unknown;
}

export interface AppServerThreadItemEntry {
  turnId: string;
  item: AppServerThreadItem;
  [key: string]: unknown;
}

export interface AppServerThreadItemsListParams {
  threadId: string;
  turnId?: string | null;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: AppServerSortDirection | null;
  [key: string]: unknown;
}

export interface AppServerThreadItemsListResponse {
  data: AppServerThreadItemEntry[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
  [key: string]: unknown;
}

export interface AppServerThreadStartParams {
  [key: string]: unknown;
}

export interface AppServerThreadStartResponse {
  thread: AppServerThread;
  [key: string]: unknown;
}

export interface AppServerThreadResumeParams {
  threadId: string;
  [key: string]: unknown;
}

export type AppServerThreadResumeResponse = AppServerThreadStartResponse;

export interface AppServerTurnStartParams {
  threadId: string;
  input: AppServerUserInput[];
  [key: string]: unknown;
}

export interface AppServerTurnStartResponse {
  turn: AppServerTurn;
  [key: string]: unknown;
}

export interface AppServerTurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: AppServerUserInput[];
  [key: string]: unknown;
}

export interface AppServerTurnSteerResponse {
  turnId: string;
  [key: string]: unknown;
}

export interface AppServerTurnInterruptParams {
  threadId: string;
  turnId: string;
  [key: string]: unknown;
}

export type AppServerTurnInterruptResponse = Record<string, never>;

export interface AppServerNotification<P = unknown> {
  method: string;
  params: P;
}

export interface AppServerIncomingRequest<P = unknown> {
  id: AppServerRequestId;
  method: string;
  params: P;
}

export interface AppServerRequestOptions {
  /** A value of zero disables the timeout for this request. */
  timeoutMs?: number;
  /** Cancels the local pending request without waiting for its timeout. */
  signal?: AbortSignal;
}

export type AppServerNotificationListener = (
  notification: AppServerNotification,
) => void;
export type AppServerRequestHandler = (
  request: AppServerIncomingRequest,
) => unknown | Promise<unknown>;
export type AppServerErrorListener = (error: Error) => void;
export type AppServerStderrListener = (text: string) => void;

export interface CodexAppServerClientOptions {
  /** Executable to spawn. Defaults to `codex`. */
  binary?: string;
  /** Complete argv for the executable. Defaults to `["app-server", "--stdio"]`. */
  args?: readonly string[];
  cwd?: string;
  /** Environment entries are merged over the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Environment keys to remove after merging, before the child is spawned. */
  unsetEnv?: readonly string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  clientInfo?: AppServerClientInfo;
  capabilities?: AppServerInitializeCapabilities | null;
  serverRequestHandler?: AppServerRequestHandler;
  onNotification?: AppServerNotificationListener;
  onError?: AppServerErrorListener;
  onStderr?: AppServerStderrListener;
}

interface AppServerErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly requestId?: AppServerRequestId;
  readonly method?: string;

  constructor(
    code: number,
    message: string,
    options: {
      data?: unknown;
      requestId?: AppServerRequestId;
      method?: string;
    } = {},
  ) {
    super(message);
    this.name = "AppServerRpcError";
    this.code = code;
    this.data = options.data;
    this.requestId = options.requestId;
    this.method = options.method;
  }
}

export class AppServerRequestTimeoutError extends Error {
  readonly requestId: AppServerRequestId;
  readonly method: string;
  readonly timeoutMs: number;

  constructor(requestId: AppServerRequestId, method: string, timeoutMs: number) {
    super(`App Server request ${method} timed out after ${timeoutMs}ms`);
    this.name = "AppServerRequestTimeoutError";
    this.requestId = requestId;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class AppServerClientClosedError extends Error {
  constructor(message = "Codex App Server client is closed") {
    super(message);
    this.name = "AppServerClientClosedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is AppServerRequestId {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}

function validateDuration(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return duration;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal.reason === undefined ? "App Server request was aborted" : String(signal.reason),
  );
  error.name = "AbortError";
  return error;
}

/**
 * A single-process client for the newline-delimited Codex App Server protocol.
 * Constructing the client spawns the process; call `initialize()` before using
 * thread/turn helpers, or use `CodexAppServerClient.connect()`.
 */
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly defaultRequestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly defaultInitializeParams: AppServerInitializeParams;
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private readonly notificationListeners = new Set<AppServerNotificationListener>();
  private readonly errorListeners = new Set<AppServerErrorListener>();
  private readonly stderrListeners = new Set<AppServerStderrListener>();
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private requestHandler: AppServerRequestHandler | null;
  private nextRequestId = 0;
  private exited = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private initializePromise: Promise<AppServerInitializeResponse> | null = null;
  private initializeResult: AppServerInitializeResponse | null = null;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.defaultRequestTimeoutMs = validateDuration(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.shutdownTimeoutMs = validateDuration(
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs",
    );
    this.defaultInitializeParams = {
      clientInfo: options.clientInfo ?? {
        name: "ai_task_board_bridge",
        title: "AI Task Board Codex Bridge",
        version: "0.4.1",
      },
      capabilities: options.capabilities ?? null,
    };
    this.requestHandler = options.serverRequestHandler ?? null;
    if (options.onNotification) {
      this.notificationListeners.add(options.onNotification);
    }
    if (options.onError) this.errorListeners.add(options.onError);
    if (options.onStderr) this.stderrListeners.add(options.onStderr);

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    const childEnvironment = { ...process.env, ...options.env };
    for (const name of options.unsetEnv ?? []) delete childEnvironment[name];

    this.child = spawn(
      options.binary ?? "codex",
      [...(options.args ?? ["app-server", "--stdio"])],
      {
        cwd: options.cwd,
        env: childEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const listener of this.stderrListeners) {
        try {
          listener(text);
        } catch (error) {
          this.reportError(asError(error));
        }
      }
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closing) this.reportError(error);
    });
    this.child.stdout.on("error", (error) => {
      if (!this.closing) this.reportError(error);
    });
    this.child.stderr.on("error", (error) => {
      if (!this.closing) this.reportError(error);
    });
    this.child.on("error", (error) => {
      this.failPending(error);
      if (!this.closing) this.reportError(error);
    });
    this.child.on("close", (code, signal) => {
      this.handleProcessClose(code, signal);
    });
  }

  static async connect(
    options: CodexAppServerClientOptions = {},
  ): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isClosed(): boolean {
    return this.closing || this.exited;
  }

  get isInitialized(): boolean {
    return this.initializeResult !== null;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  onNotification(listener: AppServerNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onError(listener: AppServerErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onStderr(listener: AppServerStderrListener): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  setServerRequestHandler(handler: AppServerRequestHandler | null): void {
    this.requestHandler = handler;
  }

  async initialize(
    params: AppServerInitializeParams = this.defaultInitializeParams,
  ): Promise<AppServerInitializeResponse> {
    if (this.initializeResult) return this.initializeResult;
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
      const result = await this.request<AppServerInitializeResponse>(
        "initialize",
        params,
      );
      await this.notify("initialized", {});
      this.initializeResult = result;
      return result;
    })();
    return this.initializePromise;
  }

  request<T = unknown>(
    method: string,
    params: unknown = {},
    options: AppServerRequestOptions = {},
  ): Promise<T> {
    if (this.isClosed) {
      return Promise.reject(new AppServerClientClosedError());
    }
    if (options.signal?.aborted) {
      return Promise.reject(abortError(options.signal));
    }
    const timeoutMs = validateDuration(
      options.timeoutMs,
      this.defaultRequestTimeoutMs,
      "timeoutMs",
    );
    const id = this.allocateRequestId();
    const message = { method, id, params };

    const promise = new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;
      let onAbort: (() => void) | undefined;
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        },
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.rejectPending(
            id,
            new AppServerRequestTimeoutError(id, method, timeoutMs),
          );
        }, timeoutMs);
      }
      this.pending.set(id, pending);

      if (signal) {
        onAbort = () => this.rejectPending(id, abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }

      if (!this.pending.has(id)) return;
      void this.writeMessage(message).catch((error) => {
        this.rejectPending(id, asError(error));
      });
    });

    return promise as Promise<T>;
  }

  notify(method: string, params: unknown = {}): Promise<void> {
    return this.writeMessage({ method, params });
  }

  async threadList(
    params: AppServerThreadListParams = {},
    options?: AppServerRequestOptions,
  ): Promise<AppServerThreadListResponse> {
    return this.initializedRequest("thread/list", params, options);
  }

  async threadRead(
    params: AppServerThreadReadParams,
    options?: AppServerRequestOptions,
  ): Promise<AppServerThreadReadResponse> {
    return this.initializedRequest("thread/read", params, options);
  }

  async threadTurnsList(
    params: AppServerThreadTurnsListParams,
    options?: AppServerRequestOptions,
  ): Promise<AppServerThreadTurnsListResponse> {
    return this.initializedRequest("thread/turns/list", params, options);
  }

  async threadItemsList(
    params: AppServerThreadItemsListParams,
    options?: AppServerRequestOptions,
  ): Promise<AppServerThreadItemsListResponse> {
    return this.initializedRequest("thread/items/list", params, options);
  }

  async threadStart(
    params: AppServerThreadStartParams = {},
    options?: AppServerRequestOptions,
  ): Promise<AppServerThreadStartResponse> {
    return this.initializedRequest("thread/start", params, options);
  }

  async threadResume(
    params: AppServerThreadResumeParams,
    options?: AppServerRequestOptions,
  ): Promise<AppServerThreadResumeResponse> {
    return this.initializedRequest("thread/resume", params, options);
  }

  async turnStart(
    params: AppServerTurnStartParams,
    options?: AppServerRequestOptions,
  ): Promise<AppServerTurnStartResponse> {
    return this.initializedRequest("turn/start", params, options);
  }

  async turnSteer(
    params: AppServerTurnSteerParams,
    options?: AppServerRequestOptions,
  ): Promise<AppServerTurnSteerResponse> {
    return this.initializedRequest("turn/steer", params, options);
  }

  async turnInterrupt(
    params: AppServerTurnInterruptParams,
    options?: AppServerRequestOptions,
  ): Promise<AppServerTurnInterruptResponse> {
    return this.initializedRequest("turn/interrupt", params, options);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeProcess();
    return this.closePromise;
  }

  private async initializedRequest<T>(
    method: string,
    params: unknown,
    options?: AppServerRequestOptions,
  ): Promise<T> {
    if (!this.initializePromise) {
      throw new Error(`initialize() must complete before calling ${method}`);
    }
    await this.initializePromise;
    return this.request<T>(method, params, options);
  }

  private allocateRequestId(): number {
    do {
      this.nextRequestId = this.nextRequestId >= Number.MAX_SAFE_INTEGER
        ? 1
        : this.nextRequestId + 1;
    } while (this.pending.has(this.nextRequestId));
    return this.nextRequestId;
  }

  private writeMessage(message: unknown): Promise<void> {
    if (this.isClosed || !this.child.stdin.writable) {
      return Promise.reject(new AppServerClientClosedError());
    }

    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      return Promise.reject(asError(error));
    }

    return new Promise((resolve, reject) => {
      try {
        this.child.stdin.write(line, "utf8", (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(asError(error));
      }
    });
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.reportError(
        new Error(`Invalid JSON from Codex App Server: ${asError(error).message}`),
      );
      return;
    }
    if (!isRecord(message)) {
      this.reportError(new Error("Invalid non-object message from Codex App Server"));
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (hasId && typeof message.method === "string") {
      if (!isRequestId(message.id)) {
        this.reportError(new Error("App Server request contained an invalid id"));
        return;
      }
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (hasId) {
      if (!isRequestId(message.id)) {
        this.reportError(new Error("App Server response contained an invalid id"));
        return;
      }
      this.handleResponse(message.id, message);
      return;
    }

    if (typeof message.method === "string") {
      const notification: AppServerNotification = {
        method: message.method,
        params: message.params,
      };
      for (const listener of this.notificationListeners) {
        try {
          listener(notification);
        } catch (error) {
          this.reportError(asError(error));
        }
      }
      return;
    }

    this.reportError(new Error("Unrecognized message from Codex App Server"));
  }

  private handleResponse(
    id: AppServerRequestId,
    message: Record<string, unknown>,
  ): void {
    const pending = this.pending.get(id);
    // A late response after a timeout is expected and can be safely ignored.
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();

    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      const error = this.parseRpcError(message.error, id, pending.method);
      pending.reject(error);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, "result")) {
      pending.reject(
        new Error(`App Server response for ${pending.method} has no result or error`),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private parseRpcError(
    value: unknown,
    requestId: AppServerRequestId,
    method: string,
  ): AppServerRpcError {
    if (!isRecord(value)) {
      return new AppServerRpcError(-32603, "Invalid App Server error response", {
        data: value,
        requestId,
        method,
      });
    }
    const code = typeof value.code === "number" ? value.code : -32603;
    const message = typeof value.message === "string"
      ? value.message
      : "Unknown App Server error";
    return new AppServerRpcError(code, message, {
      data: value.data,
      requestId,
      method,
    });
  }

  private async handleServerRequest(
    request: AppServerIncomingRequest,
  ): Promise<void> {
    try {
      if (!this.requestHandler) {
        throw new AppServerRpcError(
          -32601,
          `No handler registered for ${request.method}`,
        );
      }
      const result = await this.requestHandler(request);
      await this.writeMessage({ id: request.id, result: result ?? null });
    } catch (error) {
      const rpcError = error instanceof AppServerRpcError
        ? error
        : new AppServerRpcError(-32603, asError(error).message);
      const payload: AppServerErrorPayload = {
        code: rpcError.code,
        message: rpcError.message,
      };
      if (rpcError.data !== undefined) payload.data = rpcError.data;
      try {
        await this.writeMessage({ id: request.id, error: payload });
      } catch (writeError) {
        if (!this.closing) this.reportError(asError(writeError));
      }
    }
  }

  private rejectPending(id: AppServerRequestId, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    pending.reject(error);
  }

  private failPending(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.rejectPending(id, error);
    }
  }

  private reportError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // Error listeners are observability hooks and must not break the client.
      }
    }
  }

  private handleProcessClose(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.exited) return;
    this.exited = true;
    this.lines.close();
    const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    const error = new AppServerClientClosedError(
      `Codex App Server process exited with ${suffix}`,
    );
    this.failPending(error);
    if (!this.closing) this.reportError(error);
    this.resolveExit();
  }

  private async closeProcess(): Promise<void> {
    if (this.exited) return;
    this.closing = true;
    this.failPending(new AppServerClientClosedError());

    try {
      this.child.stdin.end();
    } catch {
      // The process may already have closed stdin while its close event is pending.
    }

    if (await this.waitForExit(this.shutdownTimeoutMs)) return;
    this.child.kill("SIGTERM");
    if (await this.waitForExit(Math.min(1_000, this.shutdownTimeoutMs))) return;
    this.child.kill("SIGKILL");
    await this.waitForExit(1_000);
  }

  private async waitForExit(milliseconds: number): Promise<boolean> {
    if (this.exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

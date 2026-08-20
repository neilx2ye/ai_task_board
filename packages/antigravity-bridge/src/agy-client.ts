import { spawn, type ChildProcess } from "node:child_process";

import type { AntigravityBridgeConfiguration } from "./config.js";
import {
  compareSemver,
  errorMessage,
  isRecord,
  stringValue,
} from "./utils.js";

export const ANTIGRAVITY_MINIMUM_VERSION = "1.1.8";
/** Headless image reads through the agent's file tool are reliable from 1.1.11. */
export const ANTIGRAVITY_IMAGE_MINIMUM_VERSION = "1.1.11";
export const AGY_STREAM_PROTOCOL = "agy-stream-json/v1";

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

const AGY_REASONING_EFFORTS = ["low", "medium", "high"] as const;

export const ANTIGRAVITY_FALLBACK_MODEL_CATALOG: readonly InventoryModel[] = [
  {
    id: "gemini-3.5-flash-medium",
    model: "gemini-3.5-flash-medium",
    display_name: "Gemini 3.5 Flash (Medium)",
    description: "Google Antigravity CLI 兼容编码模型",
    default_reasoning_effort: null,
    supported_reasoning_efforts: AGY_REASONING_EFFORTS.map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: true,
  },
  {
    id: "gemini-3.6-flash-high",
    model: "gemini-3.6-flash-high",
    display_name: "Gemini 3.6 Flash (High)",
    description: null,
    default_reasoning_effort: null,
    supported_reasoning_efforts: AGY_REASONING_EFFORTS.map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
  {
    id: "gemini-3.6-flash-medium",
    model: "gemini-3.6-flash-medium",
    display_name: "Gemini 3.6 Flash (Medium)",
    description: null,
    default_reasoning_effort: null,
    supported_reasoning_efforts: AGY_REASONING_EFFORTS.map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
  {
    id: "gemini-3.1-pro-high",
    model: "gemini-3.1-pro-high",
    display_name: "Gemini 3.1 Pro (High)",
    description: null,
    default_reasoning_effort: null,
    supported_reasoning_efforts: AGY_REASONING_EFFORTS.map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
  {
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    display_name: "Claude Sonnet 4.6 (Thinking)",
    description: null,
    default_reasoning_effort: null,
    supported_reasoning_efforts: AGY_REASONING_EFFORTS.map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
  {
    id: "claude-opus-4-6",
    model: "claude-opus-4-6",
    display_name: "Claude Opus 4.6 (Thinking)",
    description: null,
    default_reasoning_effort: null,
    supported_reasoning_efforts: AGY_REASONING_EFFORTS.map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: false,
  },
];

export type AgyUsage = {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
};

export type AgyInitEvent = {
  conversation_id?: string;
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
  agent?: string;
};

export type AgyStepUpdateEvent = {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
  tool_info?: { name?: string; error?: unknown } | null;
};

export type AgyResultEvent = {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
};

export type AgyPromptResult = {
  conversationId: string | null;
  response: string;
  status: string;
  model: string | null;
  usage: AgyUsage | null;
  durationSeconds: number | null;
  numTurns: number | null;
  toolCallCount: number;
  failedToolCallCount: number;
  checkpointCount: number;
};

export type AgyPromptOptions = {
  cwd: string;
  prompt: string;
  conversationId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  signal: AbortSignal;
  onTextDelta?: (text: string) => void;
  onConversationId?: (conversationId: string) => void;
};

export type AgyStreamState = {
  conversationId: string | null;
  initModel: string | null;
  response: string;
  status: string;
  error: string | null;
  usage: AgyUsage | null;
  durationSeconds: number | null;
  numTurns: number | null;
  toolCallCount: number;
  failedToolCallCount: number;
  checkpointCount: number;
  sawResult: boolean;
};

export function initialAgyStreamState(
  conversationId: string | null,
): AgyStreamState {
  return {
    conversationId,
    initModel: null,
    response: "",
    status: "UNKNOWN",
    error: null,
    usage: null,
    durationSeconds: null,
    numTurns: null,
    toolCallCount: 0,
    failedToolCallCount: 0,
    checkpointCount: 0,
    sawResult: false,
  };
}

/**
 * 附加失败提示：当 Bridge 启用了 --sandbox，而 agy 报出操作系统级文件访问
 * 拒绝时，说明沙箱把文件访问限制在线程工作目录内（agy 1.1.16 起会直接
 * EACCES/EPERM），跨目录读取正是最常见的触发场景。
 */
export function appendSandboxFailureHint(
  detail: string,
  sandboxEnabled: boolean,
): string {
  if (
    !sandboxEnabled ||
    !/(?:permission denied|operation not permitted|eacces|eperm)/i.test(detail)
  ) {
    return detail;
  }
  return (
    `${detail}（已启用 --sandbox：agy 会把文件访问限制在线程工作目录内，` +
    "读取目录外文件会被系统拒绝；请扩大该线程的工作目录，或设置 " +
    "ANTIGRAVITY_BRIDGE_SANDBOX=false 并重启 Bridge 后重试）"
  );
}

/**
 * Pure NDJSON event reducer for agy's documented stream-json output. Kept
 * separate from the spawn plumbing so parsing stays unit-testable.
 */
export function reduceAgyStreamEvent(
  state: AgyStreamState,
  event: Record<string, unknown>,
  hooks: {
    onTextDelta?: (text: string) => void;
    onConversationId?: (conversationId: string) => void;
  } = {},
): void {
  if (event.event === "init" && isRecord(event.init)) {
    const init = event.init as AgyInitEvent;
    if (init.conversation_id) {
      state.conversationId = init.conversation_id;
      hooks.onConversationId?.(init.conversation_id);
    }
    if (init.model) state.initModel = init.model;
    return;
  }
  if (event.event === "step_update" && isRecord(event.step_update)) {
    const step = event.step_update as AgyStepUpdateEvent;
    if (step.conversation_id) {
      state.conversationId = step.conversation_id;
      hooks.onConversationId?.(step.conversation_id);
    }
    if (step.step_type === "agent_response" && step.text_delta) {
      state.response += step.text_delta;
      hooks.onTextDelta?.(step.text_delta);
    } else if (step.step_type === "tool") {
      state.toolCallCount += 1;
      if (
        step.tool_info &&
        isRecord(step.tool_info) &&
        "error" in step.tool_info
      ) {
        state.failedToolCallCount += 1;
      }
    } else if (step.step_type === "checkpoint") {
      state.checkpointCount += 1;
    }
    return;
  }
  if (event.event === "result" && isRecord(event.result)) {
    const result = event.result as AgyResultEvent;
    state.sawResult = true;
    if (result.conversation_id) {
      state.conversationId = result.conversation_id;
      hooks.onConversationId?.(result.conversation_id);
    }
    state.status = result.status ?? "SUCCESS";
    state.response = result.response ?? state.response;
    state.usage = result.usage ?? state.usage;
    state.durationSeconds = result.duration_seconds ?? null;
    state.numTurns = result.num_turns ?? null;
    if (typeof result.error === "string" && result.error.trim()) {
      state.error = result.error;
    }
    return;
  }
  if (event.event === "error" && isRecord(event.error)) {
    // Older agy builds can emit a dedicated top-level error event instead of
    // a result event with an error field; keep whichever detail arrives.
    const detail = (event.error as Record<string, unknown>).message
      ?? (event.error as Record<string, unknown>).error
      ?? (event.error as Record<string, unknown>).detail;
    if (typeof detail === "string" && detail.trim()) {
      state.error = detail;
    }
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.AI_TASK_BOARD_CONNECTION_TOKEN;
  delete environment.AI_TASK_BOARD_URL;
  return environment;
}

function durationFlag(milliseconds: number): string {
  return `${Math.max(1, Math.round(milliseconds / 1_000))}s`;
}

function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined || child.killed) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function captureCommand(
  command: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => killTree(child, "SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: errorMessage(error) });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

type ModelListItem = { id: string; name: string; isDefault?: boolean };

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function parseModelListJson(raw: string): ModelListItem[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    let array: unknown[] | null = null;
    if (Array.isArray(parsed)) {
      array = parsed;
    } else if (isRecord(parsed)) {
      const candidates = [parsed.models, parsed.items, parsed.data].find(
        Array.isArray,
      );
      if (candidates) array = candidates as unknown[];
    }
    if (!array) return null;
    const items: ModelListItem[] = [];
    for (const candidate of array) {
      if (!isRecord(candidate)) continue;
      const id = pickString(candidate, ["id", "slug", "model", "name"]);
      if (!id) continue;
      const name =
        pickString(candidate, ["display_name", "title", "name"]) ?? id;
      items.push({
        id,
        name,
        isDefault: candidate.is_default === true || candidate.default === true,
      });
    }
    return items.length ? items : null;
  } catch {
    return null;
  }
}

export function parseModelListText(raw: string): ModelListItem[] {
  const items: ModelListItem[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
    if (!cleaned) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+(\S.*))?$/.exec(cleaned);
    if (!match) continue;
    const id = match[1];
    // Model slugs are lowercase identifiers; a capitalized first token is a
    // display-name-only row from an old `agy models` output, not a slug.
    if (!/^[a-z][a-z0-9._-]*$/.test(id)) continue;
    const name = match[2]?.trim() || id;
    items.push({ id, name });
  }
  return items;
}

export function inventoryModelFromListItem(
  item: ModelListItem,
  index: number,
): InventoryModel {
  return {
    id: item.id,
    model: item.id,
    display_name: item.name,
    description: null,
    default_reasoning_effort: null,
    supported_reasoning_efforts: AGY_REASONING_EFFORTS.map(
      (reasoning_effort) => ({ reasoning_effort, description: null }),
    ),
    input_modalities: ["text", "image"],
    is_default: item.isDefault === true || index === 0,
  };
}

export class AgyClient {
  private versionValue: string | null = null;

  constructor(
    private readonly configuration: Pick<
      AntigravityBridgeConfiguration,
      "agyBinary" | "agentMode" | "approvalMode" | "sandbox" | "printTimeoutMs"
    >,
  ) {}

  async version(): Promise<string> {
    if (this.versionValue !== null) return this.versionValue;
    const result = await captureCommand(this.configuration.agyBinary, [
      "--version",
    ]);
    const version = result.stdout.trim();
    if (!version) {
      throw new Error(
        `找不到 Antigravity CLI 可执行文件或 --version 失败：${this.configuration.agyBinary}（可通过 ANTIGRAVITY_BINARY 覆盖）`,
      );
    }
    this.versionValue = version;
    return version;
  }

  async ensureSupportedVersion(): Promise<void> {
    const version = await this.version();
    if (!compareSemver(version, 1, 1, 8)) {
      throw new Error(
        `Antigravity CLI ${version} 过旧：Antigravity Bridge 需要 >= ${ANTIGRAVITY_MINIMUM_VERSION}（stream-json 输出）。请运行 agy update 升级后重试。`,
      );
    }
  }

  async supportsImageInput(): Promise<boolean> {
    // Kept in sync with ANTIGRAVITY_IMAGE_MINIMUM_VERSION above.
    return compareSemver(await this.version(), 1, 1, 11);
  }

  async modelCatalog(): Promise<InventoryModel[]> {
    let items: ModelListItem[] | null = null;
    const jsonResult = await captureCommand(this.configuration.agyBinary, [
      "models",
      "--output-format",
      "json",
    ]);
    if (jsonResult.code === 0) {
      items = parseModelListJson(jsonResult.stdout);
    }
    if (!items) {
      const textResult = await captureCommand(this.configuration.agyBinary, [
        "models",
      ]);
      if (textResult.code === 0) {
        items = parseModelListText(textResult.stdout);
      }
    }
    if (!items?.length) {
      return ANTIGRAVITY_FALLBACK_MODEL_CATALOG.map((model) => ({ ...model }));
    }
    const unique = new Map<string, ModelListItem>();
    for (const item of items) unique.set(item.id, item);
    return [...unique.values()].map(inventoryModelFromListItem);
  }

  prompt(options: AgyPromptOptions): Promise<AgyPromptResult> {
    const args = ["-p", options.prompt, "--output-format", "stream-json"];
    if (options.conversationId) {
      args.push("--conversation", options.conversationId);
    }
    if (options.model) args.push("--model", options.model);
    if (
      options.reasoningEffort &&
      (AGY_REASONING_EFFORTS as readonly string[]).includes(
        options.reasoningEffort,
      )
    ) {
      args.push("--effort", options.reasoningEffort);
    }
    if (this.configuration.agentMode === "accept-edits") {
      args.push("--mode", "accept-edits");
    } else if (this.configuration.agentMode === "plan") {
      args.push("--mode", "plan");
    }
    if (this.configuration.approvalMode === "accept") {
      args.push("--dangerously-skip-permissions");
    }
    if (this.configuration.sandbox) args.push("--sandbox");
    args.push(
      "--print-timeout",
      durationFlag(this.configuration.printTimeoutMs),
    );

    return new Promise<AgyPromptResult>((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }

      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(this.configuration.agyBinary, args, {
          cwd: options.cwd,
          env: childEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (error) {
        reject(
          new Error(
            `无法启动 Antigravity CLI（${this.configuration.agyBinary}）：${errorMessage(error)}`,
            { cause: error },
          ),
        );
        return;
      }

      let stdoutBuffer = "";
      let stderrBuffer = "";
      const state = initialAgyStreamState(options.conversationId ?? null);

      const finishWith = (
        fn: () => void,
      ): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      const onAbort = () => {
        finishWith(() => {
          reject(options.signal.reason);
        });
        killTree(child, "SIGTERM");
        setTimeout(() => killTree(child, "SIGKILL"), 3_000).unref();
      };
      options.signal.addEventListener("abort", onAbort, { once: true });

      const safetyTimeout = setTimeout(() => {
        finishWith(() => {
          reject(
            new Error(
              `agy 在 print-timeout 加 60 秒宽限后仍未退出，已强制终止`,
            ),
          );
        });
        killTree(child, "SIGKILL");
      }, this.configuration.printTimeoutMs + 60_000);
      safetyTimeout.unref();

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (isRecord(parsed)) event = parsed;
          } catch {
            // Diagnostics belong on stderr; tolerate stray non-JSON lines.
            continue;
          }
          if (!event) continue;
          reduceAgyStreamEvent(state, event, {
            onTextDelta: options.onTextDelta,
            onConversationId: options.onConversationId,
          });
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrBuffer = `${stderrBuffer}${String(chunk)}`.slice(-100_000);
      });
      child.once("error", (error) => {
        finishWith(() => {
          reject(
            new Error(
              `无法启动 Antigravity CLI（${this.configuration.agyBinary}）：${errorMessage(error)}`,
              { cause: error },
            ),
          );
        });
      });
      child.once("exit", (code, signal) => {
        options.signal.removeEventListener("abort", onAbort);
        finishWith(() => {
          if (options.signal.aborted) {
            reject(options.signal.reason);
            return;
          }
          if (!state.sawResult) {
            const detail = stderrBuffer.trim().split(/\r?\n/).slice(-5).join("；") ||
              `退出码 ${code ?? "unknown"}${signal ? `（signal ${signal}）` : ""}`;
            reject(
              new Error(
                `agy headless 运行未返回 result 事件：${appendSandboxFailureHint(
                  detail,
                  this.configuration.sandbox,
                ).slice(0, 4_000)}`,
              ),
            );
            return;
          }
          if (state.status === "ERROR" || state.status === "INVALID") {
            const detail =
              state.error ??
              (stderrBuffer.trim().split(/\r?\n/).slice(-5).join("；") ||
                "未知错误");
            reject(
              new Error(
                `agy headless 运行失败（${state.status}）：${appendSandboxFailureHint(
                  detail,
                  this.configuration.sandbox,
                ).slice(0, 4_000)}`,
              ),
            );
            return;
          }
          resolve({
            conversationId: state.conversationId,
            response: state.response,
            status: state.status,
            model: options.model ?? state.initModel,
            usage: state.usage,
            durationSeconds: state.durationSeconds,
            numTurns: state.numTurns,
            toolCallCount: state.toolCallCount,
            failedToolCallCount: state.failedToolCallCount,
            checkpointCount: state.checkpointCount,
          });
        });
      });
    });
  }
}

const REALTIME_FALLBACK_POLL_MS = 60_000;
const WAKE_STREAM_IDLE_TIMEOUT_MS = 45_000;
const WAKE_STREAM_MAX_BUFFER = 64 * 1024;
const WAKE_CONNECT_TIMEOUT_MS = 15_000;
const WAKE_RECONNECT_MAX_MS = 30_000;

type FetchLike = typeof fetch;
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type WakeWaitResult = "wake" | "timeout" | "aborted";

/** A one-slot latch: notifications coalesce, but one arriving before wait is kept. */
export class WakeLatch {
  private pending = false;
  private waiter: ((result: WakeWaitResult) => void) | null = null;

  wake() {
    if (!this.waiter) {
      this.pending = true;
      return;
    }
    const resolve = this.waiter;
    this.waiter = null;
    this.pending = false;
    resolve("wake");
  }

  wait(milliseconds: number, signal: AbortSignal): Promise<WakeWaitResult> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve("wake");
    }
    if (signal.aborted) return Promise.resolve("aborted");
    if (this.waiter) throw new Error("WakeLatch only supports one concurrent waiter");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: WakeWaitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.waiter === finish) this.waiter = null;
        resolve(result);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), milliseconds);
      this.waiter = finish;
      signal.addEventListener("abort", onAbort, { once: true });
      // Close the small check/listener registration race.
      if (signal.aborted) onAbort();
    });
  }
}

export function adaptiveIdlePollDelay(input: {
  baseIntervalMs: number;
  emptyPolls: number;
  realtimeAvailable: boolean;
  random?: () => number;
}): number {
  const base = Math.max(1, Math.trunc(input.baseIntervalMs));
  const target = input.realtimeAvailable
    ? REALTIME_FALLBACK_POLL_MS
    : Math.min(
        REALTIME_FALLBACK_POLL_MS,
        base * 2 ** Math.min(8, Math.max(0, Math.trunc(input.emptyPolls))),
      );
  const random = input.random ?? Math.random;
  const jittered = Math.round(target * (0.9 + Math.min(1, Math.max(0, random())) * 0.2));
  return Math.min(
    REALTIME_FALLBACK_POLL_MS,
    Math.max(base, jittered),
  );
}

export function reconnectDelay(
  failures: number,
  random: () => number = Math.random,
): number {
  const target = Math.min(
    WAKE_RECONNECT_MAX_MS,
    1_000 * 2 ** Math.min(5, Math.max(0, Math.trunc(failures))),
  );
  return Math.min(
    WAKE_RECONNECT_MAX_MS,
    Math.max(250, Math.round(target * (0.75 + random() * 0.5))),
  );
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function isTerminalWakeStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Wake SSE stream became idle")),
          WAKE_STREAM_IDLE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function consumeWakeEventStream(
  response: Response,
  callbacks: {
    onReady: () => void;
    onWake: () => void;
  },
): Promise<"ended" | "degraded" | "reconnect"> {
  if (!response.body) throw new Error("Wake SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await readWithIdleTimeout(reader);
      if (done) return "ended";
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.length > WAKE_STREAM_MAX_BUFFER) {
        throw new Error("Wake SSE frame exceeded the buffer limit");
      }

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
        }
        if (event === "ready") callbacks.onReady();
        else if (event === "wake") callbacks.onWake();
        else if (event === "degraded" || event === "reconnect") return event;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function runSessionWakeListener(options: {
  endpoint: string;
  connectionToken: string;
  sessionId: string;
  signal: AbortSignal;
  onWake: () => void;
  onAvailabilityChange: (available: boolean) => void;
  log?: (message: string) => void;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  random?: () => number;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? abortableDelay;
  const random = options.random ?? Math.random;
  let available = false;
  let failures = 0;

  const setAvailable = (next: boolean) => {
    if (available === next) return;
    available = next;
    options.onAvailabilityChange(next);
  };
  const noteFailure = () => {
    failures += 1;
    if (failures === 1 || failures % 5 === 0) {
      options.log?.("实时唤醒连接中断，轮询兜底并尝试重连");
    }
  };

  while (!options.signal.aborted) {
    const requestController = new AbortController();
    const forwardAbort = () => requestController.abort(options.signal.reason);
    options.signal.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal.aborted) forwardAbort();
    const connectTimer = setTimeout(
      () => requestController.abort(new Error("Wake SSE connection timed out")),
      WAKE_CONNECT_TIMEOUT_MS,
    );
    let becameReady = false;
    let streamEnd: "ended" | "degraded" | "reconnect" | null = null;

    try {
      const response = await fetchImpl(options.endpoint, {
        method: "GET",
        signal: requestController.signal,
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${options.connectionToken}`,
          "Cache-Control": "no-cache",
          "X-AI-Session-ID": options.sessionId,
        },
      });
      clearTimeout(connectTimer);

      if (!response.ok) {
        if (isTerminalWakeStatus(response.status)) {
          options.log?.(
            `实时唤醒端点返回 HTTP ${response.status}，改用自适应轮询`,
          );
          return;
        }
        throw new Error(`Wake SSE returned HTTP ${response.status}`);
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new Error("Wake endpoint did not return an SSE stream");
      }

      streamEnd = await consumeWakeEventStream(response, {
        onReady: () => {
          becameReady = true;
          failures = 0;
          setAvailable(true);
          // Close the initial claim/subscription race even if no change event
          // was observed by performing one authoritative claim immediately.
          options.onWake();
        },
        onWake: options.onWake,
      });
      if (
        !options.signal.aborted &&
        (streamEnd !== "reconnect" || !becameReady)
      ) {
        noteFailure();
      }
    } catch {
      if (!options.signal.aborted) noteFailure();
    } finally {
      clearTimeout(connectTimer);
      options.signal.removeEventListener("abort", forwardAbort);
      requestController.abort();
      setAvailable(false);
    }

    if (options.signal.aborted) return;
    if (becameReady && streamEnd === "reconnect") failures = 0;
    await sleep(reconnectDelay(failures, random), options.signal);
  }
}

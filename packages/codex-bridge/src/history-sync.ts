import { createHash } from "node:crypto";

import type {
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
  CodexAppServerClient,
} from "./app-server-client.js";
import { redactHarnessText } from "./activity-sanitizer.js";
import { WakeLatch } from "./wake-client.js";

export const HISTORY_CONTENT_LIMIT = 50_000;
export const HISTORY_IMPORT_ITEM_LIMIT = 100;
export const HISTORY_IMPORT_BODY_LIMIT_BYTES = 512 * 1024;
export const HISTORY_SCAN_TURN_LIMIT = 500;
export const HISTORY_ITEMS_PER_TURN_LIMIT = 10_000;
export const HISTORY_ACTIVITIES_PER_SCAN_LIMIT = 500;
export const HISTORY_TARGET_QUEUE_LIMIT = 500;

const HISTORY_SCAN_PAGE_SIZE = 50;
const HISTORY_ITEM_PAGE_SIZE = 100;
const HISTORY_ITEM_PAGE_LIMIT = 200;
const HISTORY_TARGETS_PER_SLICE = 2;
const HISTORY_SLICE_DELAY_MS = 10_000;
const HISTORY_DISABLED_WAIT_MS = 60_000;
const HISTORY_TARGET_TIMEOUT_MS = 20_000;
const HISTORY_FAILURE_REPORT_TIMEOUT_MS = 3_000;
const HISTORY_FAILURE_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;
const HISTORY_SOURCE_ORDER_STRIDE = 512;
const HISTORY_LEGACY_ITEMS_PER_TURN_LIMIT = 500;
const HISTORY_SOURCE_ORDER_MAX_DISCRIMINATOR = Math.floor(
  (Number.MAX_SAFE_INTEGER - (HISTORY_SOURCE_ORDER_STRIDE - 1)) /
    HISTORY_SOURCE_ORDER_STRIDE,
);
const HISTORY_TRUNCATION_SUFFIX = "\n…[历史内容已截断]";
const HISTORY_SAFETY_CAP_CURSOR = "local-safety-cap";
const APP_SERVER_PROTOCOL = "codex-app-server/v1";

type HistoryKind = "user_message" | "assistant_message" | "reasoning";
export type HistorySyncReportStatus =
  | "syncing"
  | "partial"
  | "complete"
  | "failed";

export type HistoryImportItem = {
  external_ref: string;
  kind: HistoryKind;
  content: string;
  occurred_at: string;
  source_order: number;
  data: {
    protocol: typeof APP_SERVER_PROTOCOL;
    thread_id: string;
    turn_id: string;
    item_id: string;
  };
};

export type HistorySyncReport = {
  status: HistorySyncReportStatus;
  turn_limit: number;
  scanned_turns: number;
  total_turns: number | null;
  next_cursor: string | null;
  error: string | null;
};

export type HistoryImportRequest = {
  runtime_instance_id: string;
  report_sequence: number;
  items: HistoryImportItem[];
  sync: HistorySyncReport;
};

export type HistoryImportResponse = {
  imported: { inserted: number; replayed: number };
  history_sync: {
    status: HistorySyncReportStatus;
    turn_limit: number;
    scanned_turns: number;
    total_turns: number | null;
    imported_items: number;
    next_cursor: string | null;
    error: string | null;
    started_at: string | null;
    completed_at: string | null;
    updated_at: string;
  };
};

export type HistorySyncTarget = {
  sessionId: string;
  thread: AppServerThread;
};

export type HistoryScanResult = {
  items: HistoryImportItem[];
  scannedTurns: number;
  nextCursor: string | null;
  sourceExhausted: boolean;
  safetyCapReached: boolean;
};

type HistoryAppServer = Pick<
  CodexAppServerClient,
  "threadTurnsList" | "threadItemsList"
>;

export type HistoryImporter = (
  sessionId: string,
  request: HistoryImportRequest,
  signal: AbortSignal,
) => Promise<HistoryImportResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function protocolIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 500 &&
    value === value.trim()
    ? value
    : null;
}

function secondsValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function uuidV7Milliseconds(value: string): number | null {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(
    value,
  );
  if (!match) return null;
  const milliseconds = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function stableTurnOccurredAt(
  turn: AppServerTurn,
  threadCreatedAt: number | null,
): string {
  const timestampMilliseconds =
    (secondsValue(turn.startedAt) ?? secondsValue(turn.completedAt)) !== null
      ? (secondsValue(turn.startedAt) ?? secondsValue(turn.completedAt) ?? 0) *
        1_000
      : (uuidV7Milliseconds(turn.id) ??
        ((threadCreatedAt ?? 0) * 1_000));
  const bounded = Math.min(
    8_640_000_000_000_000,
    Math.max(0, Math.trunc(timestampMilliseconds)),
  );
  return new Date(bounded).toISOString();
}

/** Redacts known secret forms and truncates without splitting a UTF-16 pair. */
export function sanitizeHistoryContent(value: string): string {
  const redacted = redactHarnessText(value, Number.MAX_SAFE_INTEGER);
  if (redacted.length <= HISTORY_CONTENT_LIMIT) return redacted;
  let end = HISTORY_CONTENT_LIMIT - HISTORY_TRUNCATION_SUFFIX.length;
  if (/^[\uD800-\uDBFF]$/.test(redacted[end - 1] ?? "")) end -= 1;
  return `${redacted.slice(0, Math.max(0, end))}${HISTORY_TRUNCATION_SUFFIX}`;
}

function stableExternalRef(threadId: string, turnId: string, itemId: string): string {
  const direct = `codex-history:${threadId}:${turnId}:${itemId}`;
  if (direct.length <= 500) return direct;
  const digest = createHash("sha256")
    .update(threadId)
    .update("\0")
    .update(turnId)
    .update("\0")
    .update(itemId)
    .digest("hex");
  return `codex-history:sha256:${digest}`;
}

/**
 * Give every turn a stable, well-spaced tie-break range. Codex timestamps are
 * expressed in seconds, so two turns can otherwise interleave user/reasoning/
 * answer items when they share one occurred_at value. A 44-bit discriminator
 * keeps the complete range inside JavaScript's safe-integer boundary.
 */
function stableTurnSourceOrderBase(turnId: string): number {
  const discriminator =
    createHash("sha256")
      .update("codex-history-source-order\0")
      .update(turnId)
      .digest()
      .readUIntBE(0, 6) % HISTORY_SOURCE_ORDER_MAX_DISCRIMINATOR;
  return discriminator * HISTORY_SOURCE_ORDER_STRIDE;
}

function userMessageText(item: AppServerThreadItem): string | null {
  if (!Array.isArray(item.content)) return null;
  const text = item.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
  if (!text.trim()) return null;
  return sanitizeHistoryContent(text);
}

function reasoningSummary(item: AppServerThreadItem): string | null {
  if (!Array.isArray(item.summary)) return null;
  const text = item.summary
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
    .join("\n\n");
  if (!text.trim()) return null;
  return sanitizeHistoryContent(text);
}

type IndexedHistoryCandidate = {
  itemId: string;
  kind: HistoryKind;
  content: string;
  sourceIndex: number;
};

type FinalCandidateSlot = {
  seen: boolean;
  candidate: IndexedHistoryCandidate | null;
};

type HistoryCandidateCollector = {
  nonFinal: IndexedHistoryCandidate[];
  explicitFinal: FinalCandidateSlot;
  compatibleFinal: FinalCandidateSlot;
  activityLimit: number;
  overflowed: boolean;
};

function createHistoryCandidateCollector(
  activityLimit: number,
): HistoryCandidateCollector {
  return {
    nonFinal: [],
    explicitFinal: { seen: false, candidate: null },
    compatibleFinal: { seen: false, candidate: null },
    activityLimit,
    overflowed: false,
  };
}

function historyCandidate(
  item: AppServerThreadItem,
  sourceIndex: number,
  kind: HistoryKind,
  content: string | null,
): IndexedHistoryCandidate | null {
  const itemId = protocolIdentifier(item.id);
  return itemId && content && content.trim()
    ? { itemId, kind, content, sourceIndex }
    : null;
}

/** Inspect only explicitly whitelisted fields and retain a bounded projection. */
function observeHistoryItem(
  collector: HistoryCandidateCollector,
  item: AppServerThreadItem,
  sourceIndex: number,
): boolean {
  if (item.type === "userMessage") {
    if (nonEmptyString(item.clientId)) return true;
    const candidate = historyCandidate(
      item,
      sourceIndex,
      "user_message",
      userMessageText(item),
    );
    if (candidate) {
      if (collector.nonFinal.length >= collector.activityLimit) {
        collector.overflowed = true;
      } else {
        collector.nonFinal.push(candidate);
      }
    }
    return false;
  }
  if (item.type === "reasoning") {
    const candidate = historyCandidate(
      item,
      sourceIndex,
      "reasoning",
      // Deliberately read only `summary`; raw `content` is never inspected.
      reasoningSummary(item),
    );
    if (candidate) {
      if (collector.nonFinal.length >= collector.activityLimit) {
        collector.overflowed = true;
      } else {
        collector.nonFinal.push(candidate);
      }
    }
    return false;
  }
  if (item.type !== "agentMessage") return false;

  const phase = item.phase;
  if (phase !== "final_answer" && phase !== undefined && phase !== null) {
    return false;
  }
  const candidate = historyCandidate(
    item,
    sourceIndex,
    "assistant_message",
    typeof item.text === "string" && item.text.trim()
      ? sanitizeHistoryContent(item.text)
      : null,
  );
  const slot = phase === "final_answer"
    ? collector.explicitFinal
    : collector.compatibleFinal;
  // Preserve the old mapper's behavior: the last item of the selected phase
  // wins even when its identifier or text is invalid.
  slot.seen = true;
  slot.candidate = candidate;
  return false;
}

function collectedHistoryCandidates(
  collector: HistoryCandidateCollector,
): { candidates: IndexedHistoryCandidate[]; overflowed: boolean } {
  const final = collector.explicitFinal.seen
    ? collector.explicitFinal.candidate
    : collector.compatibleFinal.candidate;
  const candidates = final
    ? [...collector.nonFinal, final]
    : [...collector.nonFinal];
  return {
    candidates: candidates.sort((left, right) => left.sourceIndex - right.sourceIndex),
    overflowed:
      collector.overflowed || candidates.length > collector.activityLimit,
  };
}

function historyActivitiesFromCandidates(
  threadId: string,
  turn: AppServerTurn,
  candidates: IndexedHistoryCandidate[],
  threadCreatedAt: number | null,
  denseSourceOrder: boolean,
): HistoryImportItem[] {
  const safeThreadId = protocolIdentifier(threadId);
  const safeTurnId = protocolIdentifier(turn.id);
  if (!safeThreadId || !safeTurnId || turn.status !== "completed") return [];
  const occurredAt = stableTurnOccurredAt(turn, threadCreatedAt);
  const sourceOrderBase = stableTurnSourceOrderBase(safeTurnId);
  return candidates.map((candidate, index) => ({
    external_ref: stableExternalRef(
      safeThreadId,
      safeTurnId,
      candidate.itemId,
    ),
    kind: candidate.kind,
    content: candidate.content,
    occurred_at: occurredAt,
    // Old scans used raw indexes for turns that fit the former 500-item cap.
    // Larger turns were never importable, so a dense ordinal gives their
    // whitelisted projection a stable, non-overlapping safe-integer range.
    source_order:
      sourceOrderBase + (denseSourceOrder ? index : candidate.sourceIndex),
    data: {
      protocol: APP_SERVER_PROTOCOL,
      thread_id: safeThreadId,
      turn_id: safeTurnId,
      item_id: candidate.itemId,
    },
  }));
}

export function hasClientUserMessageId(turn: AppServerTurn): boolean {
  return (turn.items ?? []).some(
    (item) =>
      item.type === "userMessage" && nonEmptyString(item.clientId) !== null,
  );
}

/** History upload fails closed: only an explicit interactive source is safe. */
export function isInteractiveHistoryThread(thread: AppServerThread): boolean {
  const source = thread.source;
  return source === "cli" || source === "vscode";
}

export function historicalActivitiesForTurn(
  threadId: string,
  turn: AppServerTurn,
  threadCreatedAt: number | null = null,
): HistoryImportItem[] {
  if (turn.status !== "completed" || hasClientUserMessageId(turn)) return [];
  const items = Array.isArray(turn.items) ? turn.items : [];
  const collector = createHistoryCandidateCollector(Number.MAX_SAFE_INTEGER);
  for (const [sourceIndex, item] of items.entries()) {
    observeHistoryItem(collector, item, sourceIndex);
  }
  const { candidates } = collectedHistoryCandidates(collector);
  return historyActivitiesFromCandidates(
    threadId,
    turn,
    candidates,
    threadCreatedAt,
    items.length > HISTORY_LEGACY_ITEMS_PER_TURN_LIMIT,
  );
}

type TurnHistoryResult =
  | { status: "accepted"; activities: HistoryImportItem[] }
  | { status: "board_turn" }
  | { status: "safety_cap" };

async function readTurnHistory(
  appServer: HistoryAppServer,
  threadId: string,
  turn: AppServerTurn,
  threadCreatedAt: number | null,
  activityLimit: number,
  signal: AbortSignal,
): Promise<TurnHistoryResult> {
  const collector = createHistoryCandidateCollector(activityLimit);
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let rawItemCount = 0;
  let matchedItemCount = 0;
  let pageCount = 0;
  do {
    const requestLimit = Math.min(
      HISTORY_ITEM_PAGE_SIZE,
      HISTORY_ITEMS_PER_TURN_LIMIT - rawItemCount,
    );
    const page = await appServer.threadItemsList(
      {
        threadId,
        turnId: turn.id,
        cursor,
        limit: requestLimit,
        sortDirection: "asc",
      },
      { signal, timeoutMs: 10_000 },
    );
    pageCount += 1;
    if (!Array.isArray(page.data) || page.data.length > requestLimit) {
      throw new Error("Codex thread/items/list 返回无效或超预算 data");
    }
    rawItemCount += page.data.length;
    for (const entry of page.data) {
      if (entry.turnId === turn.id && isRecord(entry.item)) {
        const item = entry.item as AppServerThreadItem;
        const boardTurn = observeHistoryItem(
          collector,
          item,
          matchedItemCount,
        );
        matchedItemCount += 1;
        if (boardTurn) return { status: "board_turn" };
      }
    }
    const nextCursor = nonEmptyString(page.nextCursor);
    if (!nextCursor) {
      cursor = null;
      break;
    }
    if (nextCursor.length > 2_000 || seenCursors.has(nextCursor)) {
      throw new Error("Codex thread/items/list 返回无效 cursor");
    }
    if (
      rawItemCount >= HISTORY_ITEMS_PER_TURN_LIMIT ||
      pageCount >= HISTORY_ITEM_PAGE_LIMIT
    ) {
      return { status: "safety_cap" };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (!signal.aborted);
  if (signal.aborted) throw signal.reason;
  const { candidates, overflowed } = collectedHistoryCandidates(collector);
  if (overflowed) return { status: "safety_cap" };
  return {
    status: "accepted",
    activities: historyActivitiesFromCandidates(
      threadId,
      turn,
      candidates,
      threadCreatedAt,
      matchedItemCount > HISTORY_LEGACY_ITEMS_PER_TURN_LIMIT,
    ),
  };
}

export async function scanThreadHistory(options: {
  appServer: HistoryAppServer;
  thread: AppServerThread;
  turnLimit: number;
  signal: AbortSignal;
}): Promise<HistoryScanResult> {
  if (!Number.isInteger(options.turnLimit) || options.turnLimit < 1 || options.turnLimit > 500) {
    throw new RangeError("history turnLimit must be an integer from 1 to 500");
  }
  const accepted: HistoryImportItem[][] = [];
  const seenExternalRefs = new Set<string>();
  const threadCreatedAt = secondsValue(options.thread.createdAt);
  let acceptedActivityCount = 0;
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let rawScannedTurns = 0;
  let sourceExhausted = false;
  let safetyCapReached = false;

  scanPages:
  while (
    !options.signal.aborted &&
    accepted.length < options.turnLimit &&
    rawScannedTurns < HISTORY_SCAN_TURN_LIMIT
  ) {
    const requestLimit = Math.min(
      HISTORY_SCAN_PAGE_SIZE,
      options.turnLimit - accepted.length,
      HISTORY_SCAN_TURN_LIMIT - rawScannedTurns,
    );
    const page = await options.appServer.threadTurnsList(
      {
        threadId: options.thread.id,
        cursor,
        limit: requestLimit,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      { signal: options.signal, timeoutMs: 10_000 },
    );
    if (!Array.isArray(page.data) || page.data.length > requestLimit) {
      throw new Error("Codex thread/turns/list 返回无效或超预算 data");
    }
    const pageNextCursor = nonEmptyString(page.nextCursor);
    if (
      pageNextCursor &&
      (pageNextCursor.length > 2_000 || seenCursors.has(pageNextCursor))
    ) {
      throw new Error("Codex thread/turns/list 返回无效 cursor");
    }
    rawScannedTurns += page.data.length;
    for (const candidate of page.data) {
      if (candidate.status !== "completed") continue;
      const turn = await readTurnHistory(
        options.appServer,
        options.thread.id,
        candidate,
        threadCreatedAt,
        HISTORY_ACTIVITIES_PER_SCAN_LIMIT - acceptedActivityCount,
        options.signal,
      );
      if (turn.status === "board_turn") continue;
      if (turn.status === "safety_cap") {
        safetyCapReached = true;
        cursor = HISTORY_SAFETY_CAP_CURSOR;
        break scanPages;
      }
      const activities = turn.activities;
      for (const activity of activities) {
        if (seenExternalRefs.has(activity.external_ref)) {
          throw new Error("Codex 历史返回重复 item id");
        }
        seenExternalRefs.add(activity.external_ref);
      }
      acceptedActivityCount += activities.length;
      if (acceptedActivityCount > HISTORY_ACTIVITIES_PER_SCAN_LIMIT) {
        throw new Error("Codex 历史活动边界检查失败");
      }
      accepted.push(activities);
    }
    if (!pageNextCursor || page.data.length === 0) {
      cursor = null;
      sourceExhausted = true;
      break;
    }
    seenCursors.add(pageNextCursor);
    cursor = pageNextCursor;
  }
  if (options.signal.aborted) throw options.signal.reason;
  return {
    items: accepted.reverse().flat(),
    scannedTurns: accepted.length,
    nextCursor: cursor,
    sourceExhausted,
    safetyCapReached,
  };
}

export function splitHistoryImportItems(
  runtimeInstanceId: string,
  items: HistoryImportItem[],
  sync: HistorySyncReport,
): HistoryImportItem[][] {
  if (items.length === 0) return [[]];
  const batches: HistoryImportItem[][] = [];
  let current: HistoryImportItem[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    const body: HistoryImportRequest = {
      runtime_instance_id: runtimeInstanceId,
      // Use the largest encoded sequence so the returned batches remain below
      // the byte ceiling when their real monotonically increasing value is set.
      report_sequence: Number.MAX_SAFE_INTEGER,
      items: candidate,
      sync,
    };
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (
      current.length > 0 &&
      (candidate.length > HISTORY_IMPORT_ITEM_LIMIT ||
        bytes > HISTORY_IMPORT_BODY_LIMIT_BYTES)
    ) {
      batches.push(current);
      current = [item];
    } else {
      current = candidate;
    }
    const singleBytes = Buffer.byteLength(
      JSON.stringify({
        runtime_instance_id: runtimeInstanceId,
        report_sequence: Number.MAX_SAFE_INTEGER,
        items: current,
        sync,
      } satisfies HistoryImportRequest),
      "utf8",
    );
    if (
      current.length > HISTORY_IMPORT_ITEM_LIMIT ||
      singleBytes > HISTORY_IMPORT_BODY_LIMIT_BYTES
    ) {
      throw new Error("单条 Codex 历史活动超过批量导入安全上限");
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function abortMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function linkedTimeoutController(
  parent: AbortSignal,
  milliseconds: number,
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Codex 历史同步超过单 thread 时间预算")),
    milliseconds,
  );
  if (parent.aborted) forwardAbort();
  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", forwardAbort);
    },
  };
}

async function waitUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

type HistoryFailureState = {
  signature: string;
  attempts: number;
  retryAt: number;
};

export class HistorySynchronizer {
  private readonly wakeLatch = new WakeLatch();
  private readonly targets = new Map<string, HistorySyncTarget>();
  private readonly queuedSignatures = new Map<string, string>();
  private readonly completedSignatures = new Map<string, string>();
  private readonly failures = new Map<string, HistoryFailureState>();
  private queue: string[] = [];
  private activeController: AbortController | null = null;
  private activeThreadId: string | null = null;
  private activeSignature: string | null = null;
  private runPromise: Promise<void> | null = null;
  private configurationGeneration = 0;
  private wakeGeneration = 0;
  private reportSequence = 0;
  private stopped = false;

  constructor(
    private readonly options: {
      appServer: HistoryAppServer;
      runtimeInstanceId: string;
      configuration: () => { enabled: boolean; turnLimit: number };
      importHistory: HistoryImporter;
      log?: (message: string) => void;
    },
  ) {}

  start(signal: AbortSignal): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.runPromise ??= this.run(signal);
    return this.runPromise;
  }

  updateTargets(targets: HistorySyncTarget[]): void {
    if (this.stopped) return;
    const bounded = targets.slice(0, HISTORY_TARGET_QUEUE_LIMIT);
    const nextIds = new Set(bounded.map((target) => target.thread.id));
    for (const threadId of this.targets.keys()) {
      if (nextIds.has(threadId)) continue;
      this.targets.delete(threadId);
      this.queuedSignatures.delete(threadId);
      this.completedSignatures.delete(threadId);
      this.failures.delete(threadId);
    }
    if (this.activeThreadId && !nextIds.has(this.activeThreadId)) {
      this.activeController?.abort(new Error("Codex history target was removed"));
    }
    this.queue = this.queue.filter((threadId) => nextIds.has(threadId));
    const configuration = this.options.configuration();
    const now = Date.now();
    for (const target of bounded) {
      const threadId = target.thread.id;
      this.targets.set(threadId, target);
      const signature = this.targetSignature(target, configuration.turnLimit);
      if (this.activeThreadId === threadId) {
        if (this.activeSignature === signature) continue;
        this.activeController?.abort(
          new Error("Codex history target changed while syncing"),
        );
      }
      if (this.queuedSignatures.get(threadId) === signature) continue;
      if (this.completedSignatures.get(threadId) === signature) continue;

      const failure = this.failures.get(threadId);
      if (failure?.signature !== signature) this.failures.delete(threadId);
      if (
        failure?.signature === signature &&
        (failure.attempts > HISTORY_FAILURE_RETRY_DELAYS_MS.length ||
          failure.retryAt > now)
      ) {
        continue;
      }

      // Replace a stale queued version instead of adding the same thread twice.
      this.queue = this.queue.filter((queuedThreadId) => queuedThreadId !== threadId);
      this.queue.push(threadId);
      this.queuedSignatures.set(threadId, signature);
    }
    this.wakeGeneration += 1;
    this.wakeLatch.wake();
  }

  configurationChanged(): void {
    if (this.stopped) return;
    this.configurationGeneration += 1;
    this.wakeGeneration += 1;
    this.activeController?.abort(new Error("Codex 历史同步配置已更改"));
    this.wakeLatch.wake();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.wakeGeneration += 1;
    this.activeController?.abort(new Error("Codex Bridge 正在停止"));
    this.wakeLatch.wake();
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopped) {
      const configuration = this.options.configuration();
      if (!configuration.enabled || this.queue.length === 0) {
        await this.wakeLatch.wait(HISTORY_DISABLED_WAIT_MS, signal);
        continue;
      }
      let processed = 0;
      const targetBudget = Math.min(
        HISTORY_TARGETS_PER_SLICE,
        this.queue.length,
      );
      const sliceGeneration = this.wakeGeneration;
      while (
        !signal.aborted &&
        !this.stopped &&
        processed < targetBudget &&
        this.queue.length > 0 &&
        this.options.configuration().enabled
      ) {
        const threadId = this.queue.shift();
        if (!threadId) break;
        const queuedSignature = this.queuedSignatures.get(threadId) ?? null;
        this.queuedSignatures.delete(threadId);
        const target = this.targets.get(threadId);
        if (!target || !queuedSignature) continue;
        const currentSignature = this.targetSignature(
          target,
          this.options.configuration().turnLimit,
        );
        if (currentSignature !== queuedSignature) continue;
        await this.syncTarget(target, queuedSignature, signal);
        processed += 1;
      }
      const waitResult = await this.wakeLatch.wait(HISTORY_SLICE_DELAY_MS, signal);
      if (
        waitResult === "wake" &&
        !signal.aborted &&
        this.wakeGeneration === sliceGeneration
      ) {
        // Consume a wake that was queued before this slice, then still honor
        // the background budget before rescanning the same durable history.
        await this.wakeLatch.wait(HISTORY_SLICE_DELAY_MS, signal);
      }
    }
  }

  private async syncTarget(
    target: HistorySyncTarget,
    signature: string,
    parentSignal: AbortSignal,
  ): Promise<void> {
    if (!isInteractiveHistoryThread(target.thread)) return;
    const linked = linkedTimeoutController(parentSignal, HISTORY_TARGET_TIMEOUT_MS);
    this.activeController = linked.controller;
    this.activeThreadId = target.thread.id;
    this.activeSignature = signature;
    const configurationGeneration = this.configurationGeneration;
    const turnLimit = this.options.configuration().turnLimit;
    try {
      await this.options.importHistory(
        target.sessionId,
        this.historyRequest(
          [],
          {
            status: "syncing",
            turn_limit: turnLimit,
            scanned_turns: 0,
            total_turns: null,
            next_cursor: null,
            error: null,
          },
        ),
        linked.controller.signal,
      );
      const result = await scanThreadHistory({
        appServer: this.options.appServer,
        thread: target.thread,
        turnLimit,
        signal: linked.controller.signal,
      });
      if (result.items.length > HISTORY_ACTIVITIES_PER_SCAN_LIMIT) {
        throw new Error("Codex 历史活动数超过单次同步安全上限");
      }
      if (!this.options.configuration().enabled) return;
      // Reaching the configured limit is a complete bounded snapshot. `partial`
      // is reserved for a safety cap that stopped scanning before that limit.
      const complete =
        !result.safetyCapReached &&
        (result.sourceExhausted || result.scannedTurns >= turnLimit);
      const finalStatus: HistorySyncReportStatus = complete
        ? "complete"
        : "partial";
      if (result.safetyCapReached) {
        this.options.log?.(
          `Thread ${target.thread.id} 历史同步达到本地安全上限，已标记 partial`,
        );
      }
      const finalSync: HistorySyncReport = {
        status: finalStatus,
        turn_limit: turnLimit,
        scanned_turns: result.scannedTurns,
        total_turns: null,
        next_cursor:
          complete ? null : (result.nextCursor ?? HISTORY_SAFETY_CAP_CURSOR),
        error: null,
      };
      const batches = splitHistoryImportItems(
        this.options.runtimeInstanceId,
        result.items,
        finalSync,
      );
      for (const [index, items] of batches.entries()) {
        if (!this.options.configuration().enabled) return;
        const last = index === batches.length - 1;
        await this.options.importHistory(
          target.sessionId,
          this.historyRequest(
            items,
            last
              ? finalSync
              : { ...finalSync, status: "syncing", error: null },
          ),
          linked.controller.signal,
        );
      }
      const currentTarget = this.targets.get(target.thread.id);
      if (
        currentTarget &&
        signature ===
          this.targetSignature(
            currentTarget,
            this.options.configuration().turnLimit,
          )
      ) {
        this.completedSignatures.set(target.thread.id, signature);
        this.failures.delete(target.thread.id);
      }
    } catch (error) {
      const currentTarget = this.targets.get(target.thread.id);
      if (
        parentSignal.aborted ||
        this.stopped ||
        configurationGeneration !== this.configurationGeneration ||
        !currentTarget ||
        signature !==
          this.targetSignature(
            currentTarget,
            this.options.configuration().turnLimit,
          ) ||
        !this.options.configuration().enabled
      ) {
        return;
      }
      const message = sanitizeHistoryContent(abortMessage(error));
      let errorMessage = message.slice(0, 2_000);
      if (/^[\uD800-\uDBFF]$/.test(errorMessage.at(-1) ?? "")) {
        errorMessage = errorMessage.slice(0, -1);
      }
      this.options.log?.(
        `Thread ${target.thread.id} 历史同步失败：${errorMessage}`,
      );
      const failedSync: HistorySyncReport = {
        status: "failed",
        turn_limit: turnLimit,
        scanned_turns: 0,
        total_turns: null,
        next_cursor: null,
        error: errorMessage,
      };
      const previousFailure = this.failures.get(target.thread.id);
      const attempts =
        previousFailure?.signature === signature
          ? previousFailure.attempts + 1
          : 1;
      const retryDelay =
        HISTORY_FAILURE_RETRY_DELAYS_MS[attempts - 1] ?? Number.POSITIVE_INFINITY;
      this.failures.set(target.thread.id, {
        signature,
        attempts,
        retryAt: Number.isFinite(retryDelay)
          ? Date.now() + retryDelay
          : Number.POSITIVE_INFINITY,
      });
      await this.reportFailure(target.sessionId, failedSync, parentSignal);
    } finally {
      if (this.activeController === linked.controller) this.activeController = null;
      if (this.activeThreadId === target.thread.id) this.activeThreadId = null;
      if (this.activeSignature === signature) this.activeSignature = null;
      linked.cleanup();
    }
  }

  private targetSignature(target: HistorySyncTarget, turnLimit: number): string {
    const updatedAt = target.thread.updatedAt;
    const updatedMarker =
      typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? String(updatedAt)
        : `legacy:${String(target.thread.createdAt ?? "unknown")}`;
    return JSON.stringify([target.sessionId, updatedMarker, turnLimit]);
  }

  private async reportFailure(
    sessionId: string,
    sync: HistorySyncReport,
    parentSignal: AbortSignal,
  ): Promise<void> {
    const bounded = linkedTimeoutController(
      parentSignal,
      HISTORY_FAILURE_REPORT_TIMEOUT_MS,
    );
    // Keep configuration changes, target removal, and stop able to cancel this
    // independent best-effort status request as well as its short timeout.
    this.activeController = bounded.controller;
    const operation = this.options
      .importHistory(
        sessionId,
        this.historyRequest([], sync),
        bounded.controller.signal,
      )
      .then(() => undefined)
      .catch(() => undefined);
    try {
      await Promise.race([operation, waitUntilAborted(bounded.controller.signal)]);
    } finally {
      bounded.controller.abort(new Error("Codex 历史状态回报已结束"));
      if (this.activeController === bounded.controller) {
        this.activeController = null;
      }
      bounded.cleanup();
    }
  }

  private historyRequest(
    items: HistoryImportItem[],
    sync: HistorySyncReport,
  ): HistoryImportRequest {
    if (this.reportSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Codex 历史状态序列已耗尽，请重启 Bridge");
    }
    this.reportSequence += 1;
    return {
      runtime_instance_id: this.options.runtimeInstanceId,
      report_sequence: this.reportSequence,
      items,
      sync,
    };
  }
}

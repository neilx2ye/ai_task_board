"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircleIcon,
  BotIcon,
  BrainCircuitIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDotIcon,
  HistoryIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  SendIcon,
  TerminalIcon,
  UserIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";

import { ErrorState, LoadingBlock } from "@/components/states";
import {
  ACTOR_TYPE_LABEL,
  eventTypeLabel,
  SESSION_STATUS_META,
} from "@/components/task-meta";
import { reduceAppServerActivityStream } from "@/components/session-activity-stream";
import { StructuredUserInputForm } from "@/components/structured-user-input-form";
import {
  activityDetailsData,
  summarizeTokenUsage,
  type TokenUsageSummary,
} from "@/components/session-activity-present";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDateTime } from "@/components/utils";
import {
  bridgeSupportsHistorySync,
  supportsBridgeSettings,
} from "@/hooks/use-bridge-config";
import {
  compareSessionActivities,
  sessionActivityOccurredAt,
  useCreateSessionTurn,
  useSessionConversation,
  useUpdateSessionProcessDetailsSync,
  mergeSessionConversationPages,
} from "@/hooks/use-sessions";
import {
  effectiveSessionStatus,
  isSessionAlive,
} from "@/lib/domain/session-presence";
import type {
  ActorType,
  Json,
  SessionActivityKind,
  SessionHistorySync,
  TaskEventRow,
  TaskMessageRow,
  TaskRow,
} from "@/lib/types/database";
import type { SessionActivityItem, SessionListItem } from "@/lib/types/domain";

type TimelineEntry =
  | {
      source: "activity";
      key: string;
      createdAt: string;
      activity: SessionActivityItem;
    }
  | {
      source: "message";
      key: string;
      createdAt: string;
      message: TaskMessageRow;
    }
  | {
      source: "event";
      key: string;
      createdAt: string;
      event: TaskEventRow;
    };

const TOOL_ACTIVITY_KINDS = new Set<SessionActivityKind>([
  "command",
  "file_change",
  "mcp_tool",
  "web_search",
]);

// 这些控制面事件已有更完整的消息或 SessionActivity 视图；重复渲染只会
// 把真正的执行过程淹没。claim 心跳也不属于用户需要阅读的对话内容。
const HIDDEN_LEGACY_EVENT_TYPES = new Set([
  "session_activity_reported",
  "message_posted",
  "claim_heartbeat",
]);

const ACTIVITY_LABEL: Record<SessionActivityKind, string> = {
  user_message: "用户消息",
  assistant_message: "AI 回复",
  reasoning: "思考摘要",
  command: "命令执行",
  file_change: "文件变更",
  mcp_tool: "MCP 工具",
  web_search: "网页搜索",
  plan: "任务计划",
  error: "执行错误",
  usage: "用量信息",
  status: "状态更新",
};

type HistorySyncDetails = SessionHistorySync;

export type HistorySyncUiState =
  | "unauthorized"
  | "not-started"
  | HistorySyncDetails["status"];

export function historySyncUiState(
  historySync: HistorySyncDetails | null,
  bridgeVersion: string | null,
): HistorySyncUiState {
  if (historySync) return historySync.status;
  return bridgeSupportsHistorySync(bridgeVersion)
    ? "not-started"
    : "unauthorized";
}

function isCodexHistoryActivity(activity: SessionActivityItem): boolean {
  return (
    activity.source === "codex_history" ||
    (activity.task_id === null &&
      activity.external_ref?.startsWith("codex-history:") === true)
  );
}

const HISTORY_SYNC_COPY: Record<
  HistorySyncUiState,
  { label: string; description: string; className: string }
> = {
  unauthorized: {
    label: "历史同步未授权",
    description:
      "Bridge 尚未上报历史同步能力或本机授权。请升级至 0.4.0+，并在设备本机设置 CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true 后再开启。",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
  "not-started": {
    label: "历史尚未同步",
    description:
      "此 Thread 未开启历史同步，或设备尚未开始。请到连接的 Bridge 设置确认期望值与本机授权。",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
  syncing: {
    label: "历史同步中",
    description: "Bridge 正在从本机 Codex 读取最近的历史 turn。",
    className: "border-sky-200 bg-sky-50 text-sky-800",
  },
  partial: {
    label: "历史同步部分完成",
    description:
      "本轮受安全扫描上限截断，只完成了部分历史；如需更多内容，请调整 Web 与本机上限并检查设备日志。",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  complete: {
    label: "历史同步完成",
    description: "本机 Codex 历史已按当前 turn 上限完成导入。",
    className: "border-teal-200 bg-teal-50 text-teal-800",
  },
  failed: {
    label: "历史同步失败",
    description: "Bridge 无法完成本次历史读取，请检查本机授权和设备日志。",
    className: "border-red-200 bg-red-50 text-red-800",
  },
};

export function HistorySyncStatus({
  historySync,
  bridgeVersion,
}: {
  historySync: HistorySyncDetails | null;
  bridgeVersion: string | null;
}) {
  const state = historySyncUiState(historySync, bridgeVersion);
  const copy = HISTORY_SYNC_COPY[state];
  const Icon =
    state === "syncing"
      ? LoaderCircleIcon
      : state === "complete"
        ? CheckCircle2Icon
        : state === "failed"
          ? AlertCircleIcon
          : HistoryIcon;

  return (
    <section
      aria-label="Codex 历史同步状态"
      data-history-sync-state={state}
      className={cn("rounded-md border px-3 py-2.5", copy.className)}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon
          className={cn("size-4 shrink-0", state === "syncing" && "animate-spin")}
        />
        <span>{copy.label}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed">{copy.description}</p>
      {historySync ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <span>
            已扫描 {historySync.scanned_turns}/
            {historySync.total_turns ?? "未知"} turns
          </span>
          <span>已导入 {historySync.imported_items} 条</span>
          <span>本次上限 {historySync.turn_limit} turns</span>
          <span>
            更新于{" "}
            <time dateTime={historySync.updated_at}>
              {formatDateTime(historySync.updated_at)}
            </time>
          </span>
        </div>
      ) : null}
      {historySync?.error ? (
        <p role="alert" className="mt-2 break-words text-xs font-medium">
          {historySync.error}
        </p>
      ) : null}
    </section>
  );
}

function formattedData(data: Json): string | null {
  if (data === null) return null;
  if (
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.keys(data).length === 0
  ) {
    return null;
  }
  return JSON.stringify(data, null, 2);
}

function taskLabel(taskId: string | null, taskById: Map<string, TaskRow>) {
  if (!taskId) return null;
  return taskById.get(taskId)?.title ?? `任务 ${taskId.slice(0, 8)}`;
}

function TimelineMeta({
  actorType,
  task,
  createdAt,
  historySource = false,
}: {
  actorType: ActorType;
  task: string | null;
  createdAt: string;
  historySource?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      <span>{ACTOR_TYPE_LABEL[actorType]}</span>
      {historySource ? (
        <Badge
          variant="outline"
          className="border-sky-200 bg-sky-50 px-1.5 py-0 text-[10px] text-sky-700"
        >
          Codex 历史
        </Badge>
      ) : null}
      {task ? (
        <>
          <span aria-hidden>·</span>
          <span className="max-w-72 truncate">{task}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <time dateTime={createdAt}>{formatDateTime(createdAt)}</time>
    </div>
  );
}

function MessageBubble({
  actorType,
  content,
  task,
  createdAt,
  historySource = false,
}: {
  actorType: ActorType;
  content: string;
  task: string | null;
  createdAt: string;
  historySource?: boolean;
}) {
  const fromUser = actorType === "user";

  return (
    <div className={cn("flex gap-2", fromUser && "flex-row-reverse")}>
      <span
        aria-hidden
        className={cn(
          "mt-1 flex size-7 shrink-0 items-center justify-center rounded-full",
          fromUser
            ? "bg-indigo-100 text-indigo-700"
            : "bg-teal-100 text-teal-700",
        )}
      >
        {fromUser ? (
          <UserIcon className="size-4" />
        ) : (
          <BotIcon className="size-4" />
        )}
      </span>
      <div
        className={cn(
          "flex max-w-[min(85%,48rem)] flex-col gap-1 rounded-2xl px-3 py-2",
          fromUser
            ? "rounded-tr-sm bg-indigo-50"
            : "rounded-tl-sm border border-teal-100 bg-teal-50/70",
        )}
      >
        <TimelineMeta
          actorType={actorType}
          task={task}
          createdAt={createdAt}
          historySource={historySource}
        />
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {content}
        </p>
      </div>
    </div>
  );
}

function ToolActivity({
  activity,
  task,
}: {
  activity: SessionActivityItem;
  task: string | null;
}) {
  const data = formattedData(activity.data);
  const preview = activity.content?.split("\n", 1)[0]?.trim();
  const Icon = activity.kind === "command" ? TerminalIcon : WrenchIcon;

  return (
    <details className="group rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-sm font-medium">
              {ACTIVITY_LABEL[activity.kind]}
            </span>
            {preview ? (
              <span className="truncate text-xs text-muted-foreground">
                {preview}
              </span>
            ) : null}
          </div>
          <TimelineMeta
            actorType={activity.actor_type}
            task={task}
            createdAt={sessionActivityOccurredAt(activity)}
            historySource={isCodexHistoryActivity(activity)}
          />
        </div>
        <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
        {activity.content ? (
          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
            {activity.content}
          </pre>
        ) : null}
        {data ? (
          <pre className="max-h-80 overflow-auto rounded-md bg-slate-950 p-3 text-xs whitespace-pre-wrap text-slate-100">
            {data}
          </pre>
        ) : null}
        {!activity.content && !data ? (
          <p className="text-xs text-muted-foreground">未提供更多过程信息。</p>
        ) : null}
      </div>
    </details>
  );
}

function ReasoningSummary({
  activity,
  task,
}: {
  activity: SessionActivityItem;
  task: string | null;
}) {
  // data 里通常只有 app-server 协议信封字段，剥离后为空则不展示详情区。
  const data = activityDetailsData(activity.data);
  const formatted = data === null ? null : JSON.stringify(data, null, 2);

  return (
    <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5">
      <BrainCircuitIcon className="mt-0.5 size-4 shrink-0 text-amber-700" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-950">思考摘要</p>
        <TimelineMeta
          actorType={activity.actor_type}
          task={task}
          createdAt={sessionActivityOccurredAt(activity)}
          historySource={isCodexHistoryActivity(activity)}
        />
        {activity.content ? (
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-amber-950">
            {activity.content}
          </p>
        ) : null}
        {formatted ? (
          <details className="mt-2 text-xs text-amber-950">
            <summary className="cursor-pointer font-medium">查看结构化摘要</summary>
            <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-amber-100/70 p-2 whitespace-pre-wrap">
              {formatted}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

const TOKEN_USAGE_ROWS: ReadonlyArray<{
  key: keyof Omit<TokenUsageSummary, "contextWindow">;
  label: string;
}> = [
  { key: "input", label: "输入" },
  { key: "cachedInput", label: "缓存命中" },
  { key: "output", label: "输出" },
  { key: "reasoningOutput", label: "其中思考输出" },
  { key: "total", label: "总计" },
];

function UsageActivity({
  activity,
  task,
}: {
  activity: SessionActivityItem;
  task: string | null;
}) {
  const summary = summarizeTokenUsage(activity.data);
  const raw = formattedData(activity.data);

  return (
    <div className="flex gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <ZapIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{ACTIVITY_LABEL.usage}</p>
        <TimelineMeta
          actorType={activity.actor_type}
          task={task}
          createdAt={sessionActivityOccurredAt(activity)}
          historySource={isCodexHistoryActivity(activity)}
        />
        {summary ? (
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {TOKEN_USAGE_ROWS.filter(({ key }) => summary[key] !== null).map(
              ({ key, label }) => (
                <div key={key} className="flex items-baseline gap-1">
                  <dt>{label}</dt>
                  <dd className="font-medium text-foreground tabular-nums">
                    {(summary[key] as number).toLocaleString()}
                  </dd>
                </div>
              ),
            )}
            {summary.contextWindow !== null ? (
              <div className="flex items-baseline gap-1">
                <dt>上下文窗口</dt>
                <dd className="font-medium text-foreground tabular-nums">
                  {summary.contextWindow.toLocaleString()}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">
            用量字段无法识别，请展开原始数据查看。
          </p>
        )}
        {raw ? (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer font-medium">查看原始数据</summary>
            <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-background/80 p-2 whitespace-pre-wrap">
              {raw}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function GeneralActivity({
  activity,
  task,
}: {
  activity: SessionActivityItem;
  task: string | null;
}) {
  const data = formattedData(activity.data);
  const isError = activity.kind === "error";
  const Icon = isError
    ? AlertCircleIcon
    : activity.kind === "plan"
      ? ListChecksIcon
      : CircleDotIcon;

  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg border px-3 py-2.5",
        isError
          ? "border-red-200 bg-red-50/70 text-red-950"
          : "border-border bg-muted/40",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          isError ? "text-red-700" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{ACTIVITY_LABEL[activity.kind]}</p>
        <TimelineMeta
          actorType={activity.actor_type}
          task={task}
          createdAt={sessionActivityOccurredAt(activity)}
          historySource={isCodexHistoryActivity(activity)}
        />
        {activity.content ? (
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {activity.content}
          </p>
        ) : null}
        {data ? (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer font-medium">查看详情</summary>
            <pre className="mt-1.5 max-h-64 overflow-auto rounded-md bg-background/80 p-2 whitespace-pre-wrap">
              {data}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function ActivityItem({
  activity,
  taskById,
}: {
  activity: SessionActivityItem;
  taskById: Map<string, TaskRow>;
}) {
  const task = taskLabel(activity.task_id, taskById);

  if (
    activity.kind === "user_message" ||
    activity.kind === "assistant_message"
  ) {
    return (
      <MessageBubble
        actorType={activity.kind === "user_message" ? "user" : "ai"}
        content={activity.content ?? "（空消息）"}
        task={task}
        createdAt={sessionActivityOccurredAt(activity)}
        historySource={isCodexHistoryActivity(activity)}
      />
    );
  }
  if (activity.kind === "reasoning") {
    return <ReasoningSummary activity={activity} task={task} />;
  }
  if (activity.kind === "usage") {
    return <UsageActivity activity={activity} task={task} />;
  }
  if (TOOL_ACTIVITY_KINDS.has(activity.kind)) {
    return <ToolActivity activity={activity} task={task} />;
  }
  return <GeneralActivity activity={activity} task={task} />;
}

function LegacyEvent({
  event,
  taskById,
}: {
  event: TaskEventRow;
  taskById: Map<string, TaskRow>;
}) {
  const data = formattedData(event.data);

  return (
    <details className="group rounded-lg border border-dashed border-border bg-muted/20">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <CircleDotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{eventTypeLabel(event.type)}</p>
          <TimelineMeta
            actorType={event.actor_type}
            task={taskLabel(event.task_id, taskById)}
            createdAt={event.created_at}
          />
        </div>
        {data ? (
          <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        ) : null}
      </summary>
      {data ? (
        <pre className="mx-3 mb-3 max-h-64 overflow-auto rounded-md bg-background p-2 text-xs whitespace-pre-wrap">
          {data}
        </pre>
      ) : null}
    </details>
  );
}

function buildTimeline(
  activities: SessionActivityItem[],
  messages: TaskMessageRow[],
  events: TaskEventRow[],
): TimelineEntry[] {
  const activityMessageIds = new Set(
    activities
      .map((activity) => activity.task_message_id)
      .filter((id): id is string => id !== null),
  );

  return [
    ...activities.map(
      (activity): TimelineEntry => ({
        source: "activity",
        key: `activity:${activity.id}`,
        createdAt: sessionActivityOccurredAt(activity),
        activity,
      }),
    ),
    ...messages
      .filter((message) => !activityMessageIds.has(message.id))
      .map(
        (message): TimelineEntry => ({
          source: "message",
          key: `message:${message.id}`,
          createdAt: message.created_at,
          message,
        }),
      ),
    ...events
      .filter((event) => !HIDDEN_LEGACY_EVENT_TYPES.has(event.type))
      .map(
        (event): TimelineEntry => ({
          source: "event",
          key: `event:${event.id}`,
          createdAt: event.created_at,
          event,
        }),
      ),
  ].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    if (byTime) return byTime;
    if (left.source === "activity" && right.source === "activity") {
      return compareSessionActivities(left.activity, right.activity);
    }
    if (left.source === "event" && right.source === "event") {
      return left.event.id - right.event.id;
    }
    return left.key.localeCompare(right.key);
  });
}

function sessionContentDescription(session: SessionListItem): string {
  return session.sync_process_details === false
    ? `${session.connection.name} · 仅同步对话与结构化问题`
    : `${session.connection.name} · 对话、思考摘要与工具过程`;
}

export function ProcessDetailsSyncToggle({
  session,
}: {
  session: SessionListItem;
}) {
  const mutation = useUpdateSessionProcessDetailsSync(session.id);
  const enabled = session.sync_process_details !== false;
  const fieldId = `session-process-details-${session.id}`;
  const descriptionId = `${fieldId}-description`;

  return (
    <div
      className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2"
      data-process-details-sync={enabled ? "enabled" : "disabled"}
    >
      <label
        htmlFor={fieldId}
        className={cn(
          "flex items-start justify-between gap-4",
          mutation.isPending ? "cursor-wait opacity-70" : "cursor-pointer",
        )}
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            同步过程详情
          </span>
          <span
            id={descriptionId}
            className="mt-0.5 block text-xs leading-relaxed text-muted-foreground"
          >
            关闭后仅同步 AI 回复与结构化问题；思考摘要、命令、工具、计划和用量不再上传，既有记录仍会保留。
          </span>
        </span>
        <input
          id={fieldId}
          type="checkbox"
          role="switch"
          aria-describedby={descriptionId}
          checked={enabled}
          disabled={mutation.isPending}
          onChange={(event) =>
            mutation.mutate({ sync_process_details: event.target.checked })
          }
          className="mt-0.5 size-4 shrink-0 accent-indigo-600"
        />
      </label>
      {mutation.error ? (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {mutation.error.message}
        </p>
      ) : mutation.isPending ? (
        <p className="mt-1.5 text-xs text-muted-foreground">正在保存设置…</p>
      ) : null}
    </div>
  );
}

function SessionConversationContent({
  session,
  active,
  presentation,
  onClose,
}: {
  session: SessionListItem | null;
  active: boolean;
  presentation: "dialog" | "panel";
  onClose?: () => void;
}) {
  const sessionId = session?.id ?? null;
  const conversationQuery = useSessionConversation(sessionId);
  const createTurn = useCreateSessionTurn(sessionId ?? "");
  const [composer, setComposer] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const prependSnapshotRef = useRef<{
    height: number;
    pageCount: number;
    top: number;
  } | null>(null);

  const details = useMemo(
    () => mergeSessionConversationPages(conversationQuery.data?.pages),
    [conversationQuery.data?.pages],
  );
  const currentSession = details?.session ?? session;
  const taskById = useMemo(
    () => new Map((details?.tasks ?? []).map((task) => [task.id, task])),
    [details?.tasks],
  );
  const activities = useMemo(
    () => reduceAppServerActivityStream(details?.activities ?? []),
    [details?.activities],
  );
  const timeline = useMemo(
    () =>
      buildTimeline(
        activities,
        details?.messages ?? [],
        details?.events ?? [],
      ),
    [activities, details?.events, details?.messages],
  );
  const pendingStructuredRequest = useMemo(
    () =>
      [...(details?.input_requests ?? [])]
        .reverse()
        .find(
          (request) =>
            request.status === "pending" &&
            taskById.get(request.task_id)?.awaiting_user_input === true,
        ) ?? null,
    [details?.input_requests, taskById],
  );
  const latestTimelineKey = timeline.at(-1)?.key ?? null;
  const latestActivityId = details?.activities.at(-1)?.id ?? null;
  const timelineRevision = `${latestTimelineKey ?? "empty"}:${latestActivityId ?? "none"}:${pendingStructuredRequest?.id ?? "no-input"}`;
  const pageCount = conversationQuery.data?.pages.length ?? 0;
  const legacyTruncated = details
    ? Object.entries(details.pagination.legacy)
        .filter(([key]) => key.endsWith("_truncated"))
        .some(([, value]) => value === true)
    : false;

  useEffect(() => {
    stickToBottomRef.current = true;
    prependSnapshotRef.current = null;
  }, [active, sessionId]);

  useLayoutEffect(() => {
    const snapshot = prependSnapshotRef.current;
    if (!snapshot || pageCount <= snapshot.pageCount) return;
    const scrollArea = scrollAreaRef.current;
    if (scrollArea) {
      scrollArea.scrollTop =
        snapshot.top + (scrollArea.scrollHeight - snapshot.height);
      stickToBottomRef.current =
        scrollArea.scrollHeight -
          scrollArea.scrollTop -
          scrollArea.clientHeight <
        160;
    }
    prependSnapshotRef.current = null;
  }, [pageCount]);

  useLayoutEffect(() => {
    if (!active || conversationQuery.isLoading) return;
    if (prependSnapshotRef.current || !stickToBottomRef.current) return;
    const scrollArea = scrollAreaRef.current;
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
  }, [active, conversationQuery.isLoading, timelineRevision]);

  const loadOlder = () => {
    const scrollArea = scrollAreaRef.current;
    if (scrollArea) {
      prependSnapshotRef.current = {
        height: scrollArea.scrollHeight,
        pageCount,
        top: scrollArea.scrollTop,
      };
    }
    void conversationQuery.fetchNextPage({ cancelRefetch: false });
  };

  const onSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = composer.trim();
    if (!content || !sessionId) return;

    setSendError(null);
    try {
      await createTurn.mutateAsync({ content });
      setComposer("");
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "发送失败，请稍后重试",
      );
    }
  };

  const sessionStatus = currentSession
    ? effectiveSessionStatus(currentSession)
    : "offline";
  const statusMeta = SESSION_STATUS_META[sessionStatus];
  const sessionAlive = currentSession ? isSessionAlive(currentSession) : false;
  const canSend = sessionAlive && !pendingStructuredRequest;

  return (
    <>
      {presentation === "dialog" ? (
        <DialogHeader className="shrink-0 border-b border-border px-4 py-4 pr-12 sm:px-6 sm:pr-14">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>{currentSession?.name ?? "会话详情"}</DialogTitle>
            <Badge className={statusMeta.badgeClass}>{statusMeta.label}</Badge>
          </div>
          <DialogDescription>
            {currentSession
              ? sessionContentDescription(currentSession)
              : "加载会话历史"}
          </DialogDescription>
          {currentSession ? (
            <ProcessDetailsSyncToggle session={currentSession} />
          ) : null}
        </DialogHeader>
      ) : (
        <header className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
              {currentSession?.name ?? "选择一个 Thread"}
            </h2>
            <Badge className={statusMeta.badgeClass}>{statusMeta.label}</Badge>
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onClose}
                aria-label={`关闭 Thread「${currentSession?.name ?? ""}」面板`}
                title="关闭面板（取消选中并清除已同步历史）"
                className="-mr-2 size-7 shrink-0"
              >
                <XIcon className="size-4" />
              </Button>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {currentSession
              ? sessionContentDescription(currentSession)
              : "从左侧选择一个 Thread 查看上下文"}
          </p>
          {currentSession ? (
            <ProcessDetailsSyncToggle session={currentSession} />
          ) : null}
        </header>
      )}

      <div
        ref={scrollAreaRef}
        onScroll={(event) => {
          const scrollArea = event.currentTarget;
          stickToBottomRef.current =
            scrollArea.scrollHeight -
              scrollArea.scrollTop -
              scrollArea.clientHeight <
            160;
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-background px-3 py-4 sm:px-6"
      >
        {details &&
        currentSession &&
        supportsBridgeSettings(currentSession.connection) ? (
          <div className="mx-auto mb-4 w-full max-w-4xl">
            <HistorySyncStatus
              historySync={details?.history_sync ?? null}
              bridgeVersion={currentSession.connection.bridge_version}
            />
          </div>
        ) : null}
        {conversationQuery.error && !details ? (
          <ErrorState
            title="加载会话历史失败"
            message={conversationQuery.error.message}
            onRetry={() => void conversationQuery.refetch()}
          />
        ) : conversationQuery.isLoading ? (
          <LoadingBlock label="加载会话历史…" />
        ) : timeline.length === 0 && !pendingStructuredRequest ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
            <BotIcon className="size-7 text-muted-foreground" />
            <p className="text-sm font-medium">还没有同步的会话记录</p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              {currentSession?.sync_process_details === false
                ? "Bridge 只会同步对话回复与结构化问题；你也可以直接发送下一项任务。"
                : "Bridge 回传的实时过程，以及启用后导入的 Codex 历史消息、回复和思考摘要会显示在这里。你也可以直接发送下一项任务。"}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
            {conversationQuery.hasNextPage ? (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={conversationQuery.isFetchingNextPage}
                  onClick={loadOlder}
                >
                  {conversationQuery.isFetchingNextPage
                    ? "正在加载…"
                    : "加载更早记录"}
                </Button>
              </div>
            ) : null}
            {conversationQuery.isFetchNextPageError ? (
              <p role="alert" className="text-center text-xs text-destructive">
                更早记录加载失败，请重试。
              </p>
            ) : null}
            {legacyTruncated ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                早期兼容记录仅显示最近 {details?.pagination.legacy.limit} 条；Harness
                同步的结构化会话记录可继续向前加载。
              </p>
            ) : null}
            <ol className="flex flex-col gap-3">
              {timeline.map((entry) => (
                <li key={entry.key}>
                  {entry.source === "activity" ? (
                    <ActivityItem
                      activity={entry.activity}
                      taskById={taskById}
                    />
                  ) : entry.source === "message" ? (
                    <MessageBubble
                      actorType={entry.message.sender_type}
                      content={entry.message.content}
                      task={taskLabel(entry.message.task_id, taskById)}
                      createdAt={entry.message.created_at}
                    />
                  ) : (
                    <LegacyEvent event={entry.event} taskById={taskById} />
                  )}
                </li>
              ))}
            </ol>
            {pendingStructuredRequest ? (
              <StructuredUserInputForm
                request={pendingStructuredRequest}
                sourceTaskTitle={
                  taskById.get(pendingStructuredRequest.task_id)?.title ?? null
                }
              />
            ) : null}
          </div>
        )}
      </div>

      {currentSession ? (
        <form
          onSubmit={onSend}
          className="shrink-0 border-t border-border bg-card px-3 py-3 sm:px-6 sm:py-4"
        >
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
            {!sessionAlive ? (
              <p className="text-xs text-amber-700">
                会话当前离线。恢复心跳后才能发送下一项任务。
              </p>
            ) : pendingStructuredRequest ? (
              <p className="text-xs text-amber-700">
                当前 turn 正在等待上方结构化回答，提交后会原地继续。
              </p>
            ) : null}
            {sendError ? (
              <p role="alert" className="text-xs text-destructive">
                {sendError}
              </p>
            ) : null}
            <div className="flex items-end gap-2">
              <Textarea
                aria-label="发送下一任务"
                value={composer}
                maxLength={100_000}
                disabled={!canSend || createTurn.isPending}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="输入下一项任务；Enter 发送，Shift + Enter 换行…"
                className="min-h-20 flex-1 resize-none"
              />
              <Button
                type="submit"
                size="icon"
                aria-label="发送下一任务"
                disabled={!canSend || createTurn.isPending || !composer.trim()}
                className="size-10 shrink-0"
              >
                <SendIcon />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              发送后会自动生成任务名称，并作为下一项任务预留给此会话。
            </p>
          </div>
        </form>
      ) : null}
    </>
  );
}

export function SessionConversationPanel({
  session,
  className,
  onClose,
}: {
  session: SessionListItem | null;
  className?: string;
  onClose?: () => void;
}) {
  return (
    <section
      aria-label={session ? `${session.name} 的对话` : "Thread 对话"}
      className={cn(
        "flex h-full min-h-[36rem] flex-col overflow-hidden bg-card lg:min-h-0",
        className,
      )}
    >
      <SessionConversationContent
        key={session?.id ?? "no-session"}
        session={session}
        active
        presentation="panel"
        onClose={onClose}
      />
    </section>
  );
}

export function SessionConversationDialog({
  session,
  open,
  onOpenChange,
}: {
  session: SessionListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:p-0">
        <SessionConversationContent
          key={`${session?.id ?? "no-session"}:${open ? "open" : "closed"}`}
          session={session}
          active={open}
          presentation="dialog"
        />
      </DialogContent>
    </Dialog>
  );
}

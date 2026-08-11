"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  CircleSlashIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  UnlockIcon,
} from "lucide-react";

import { ArtifactUpload } from "@/components/artifact-upload";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SubtaskDialog } from "@/components/subtask-dialog";
import { StructuredUserInputForm } from "@/components/structured-user-input-form";
import { TaskFormDialog } from "@/components/task-form-dialog";
import {
  ACTOR_TYPE_LABEL,
  eventTypeLabel,
  priorityLevelOf,
  TASK_STATUS_META,
} from "@/components/task-meta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useSessions } from "@/hooks/use-sessions";
import { apiFetch } from "@/hooks/api-client";
import { findPendingQuestion } from "@/hooks/pending-question";
import {
  useCancelTask,
  usePostTaskMessage,
  useReleaseTask,
  useReopenTask,
  useReplyToTask,
} from "@/hooks/use-tasks";
import { cn, formatBytes, formatDateTime, formatRelativeTime, isPast } from "@/components/utils";
import type { TaskDetails } from "@/lib/types/domain";
import type { ArtifactRow, TaskRow } from "@/lib/types/database";

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function TaskLink({ task }: { task: TaskRow }) {
  const meta = TASK_STATUS_META[
    task.awaiting_user_input ? "waiting_user" : task.status
  ];
  return (
    <Link
      href={`/tasks/${task.id}`}
      className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <Badge className={cn("shrink-0", meta.badgeClass)}>{meta.label}</Badge>
    </Link>
  );
}

function ArtifactItem({ artifact }: { artifact: ArtifactRow }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 同步打开空白页（保持用户手势上下文，避免弹窗拦截），
  // 取得句柄后立即切断 opener 引用；拿到签名 URL 后再导航，
  // 失败则关闭空白页并展示错误。window.open 返回 null 时降级为同页导航。
  const download = () => {
    setError(null);
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    setDownloading(true);
    apiFetch<{ url: string }>(`/api/user/artifacts/${artifact.id}/download`)
      .then(({ url }) => {
        if (tab) {
          tab.location.href = url;
        } else {
          window.location.assign(url);
        }
      })
      .catch((err) => {
        tab?.close();
        setError(
          err instanceof Error ? err.message : "获取下载链接失败",
        );
      })
      .finally(() => {
        setDownloading(false);
      });
  };

  return (
    <li className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2">
        <DownloadIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{artifact.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {artifact.mime_type} · {formatBytes(artifact.size)}
        </span>
        {artifact.external_url ? (
          <a
            href={artifact.external_url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            打开
          </a>
        ) : artifact.storage_path ? (
          <button
            type="button"
            disabled={downloading}
            onClick={download}
            className="shrink-0 text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {downloading ? "获取中…" : "下载"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function TaskDetailView({ details }: { details: TaskDetails }) {
  const {
    task,
    parent,
    children,
    descendants,
    dependencies,
    messages,
    events,
    artifacts,
    input_requests: inputRequests,
  } = details;

  const { data: sessions } = useSessions();
  const cancelTask = useCancelTask(task.id);
  const reopenTask = useReopenTask(task.id);
  const releaseTask = useReleaseTask(task.id);
  const postMessage = usePostTaskMessage(task.id);

  const [editOpen, setEditOpen] = useState(false);
  const [subtaskOpen, setSubtaskOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [composer, setComposer] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const hasStructuredWait = inputRequests.some(
    (request) => request.status === "pending",
  );
  const statusMeta = TASK_STATUS_META[
    task.awaiting_user_input || hasStructuredWait ? "waiting_user" : task.status
  ];
  const priority = priorityLevelOf(task.priority);
  const claimedSession = task.claimed_by_session_id
    ? sessions?.find((session) => session.id === task.claimed_by_session_id)
    : undefined;
  const assignedSession = task.assigned_session_id
    ? sessions?.find((session) => session.id === task.assigned_session_id)
    : undefined;

  // 子任务标题查找（含后代列表），用于提示回复目标。
  const knownTaskById = useMemo(() => {
    const map = new Map<string, TaskRow>();
    for (const item of [task, ...children, ...descendants]) {
      map.set(item.id, item);
    }
    return map;
  }, [task, children, descendants]);

  // 消息已聚合后代：定位最新一条待回复的 AI 问题。
  // 回复必须发送到该消息实际所属的任务（可能是后代叶子），并带上引用。
  // 所属任务当前不是 waiting_user（例如已取消）的旧问题不算待答，
  // 否则提交必然 409。
  const pendingQuestion = useMemo(
    () =>
      findPendingQuestion(
        messages,
        (taskId) => knownTaskById.get(taskId)?.status === "waiting_user",
      ),
    [messages, knownTaskById],
  );

  const pendingStructuredRequest = useMemo(
    () =>
      [...inputRequests]
        .reverse()
        .find(
          (request) =>
            request.status === "pending" &&
            knownTaskById.get(request.task_id)?.awaiting_user_input === true,
        ) ?? null,
    [inputRequests, knownTaskById],
  );

  const replyTargetTaskId = pendingQuestion?.task_id ?? task.id;
  const isDescendantQuestion =
    pendingQuestion !== null && pendingQuestion.task_id !== task.id;

  const pendingQuestionTask = pendingQuestion
    ? knownTaskById.get(pendingQuestion.task_id)
    : undefined;

  // hook 需在每次渲染稳定调用；回复目标随待答问题动态切换。
  const replyToTask = useReplyToTask(replyTargetTaskId);

  const canCancel = !["completed", "cancelled"].includes(task.status);
  // 重开只适用于已完结的叶子任务；已取消任务和聚合父任务不提供该操作。
  const canReopen =
    ["completed", "failed"].includes(task.status) && children.length === 0;
  // 释放只对自身持有领取记录的任务有意义；聚合 running 父任务没有自身
  // claim，显示释放按钮只会得到 409。
  const canRelease =
    ["claimed", "running"].includes(task.status) &&
    task.claimed_by_session_id !== null;
  // 已取消任务不可编辑。
  const canEdit = task.status !== "cancelled";
  const actionPending =
    cancelTask.isPending || reopenTask.isPending || releaseTask.isPending;

  // 拆分限制与数据库一致：等待回复 / 已取消不可拆分；
  // 只要存在领取记录（即使租约已过期）也不允许用户拆分，需先释放。
  const hasClaim = task.claimed_by_session_id !== null;
  const subtaskBlockReason = hasStructuredWait
    ? "任务正在当前 turn 中等待结构化回答，提交前不能拆分子任务。"
    : ["waiting_user", "cancelled"].includes(task.status)
    ? task.status === "waiting_user"
      ? "任务正在等待回复，回复前不能拆分子任务。"
      : "已取消的任务不能拆分子任务。"
    : hasClaim
      ? "任务仍有领取记录，请先释放任务后再添加子任务。"
      : null;
  const canAddSubtask = subtaskBlockReason === null;

  const doneChildren = children.filter(
    (child) => child.status === "completed",
  ).length;

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "操作失败，请稍后重试");
    }
  };

  const onSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = composer.trim();
    if (!content) return;
    setActionError(null);
    try {
      if (pendingQuestion) {
        await replyToTask.mutateAsync({
          content,
          reply_to_message_id: pendingQuestion.id,
        });
      } else {
        await postMessage.mutateAsync({ content });
      }
      setComposer("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "发送失败，请稍后重试");
    }
  };

  const sortedMessages = [...messages].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const sortedEvents = [...events].sort((a, b) => b.id - a.id);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link
          href="/board"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ArrowLeftIcon className="size-4" />
          返回看板
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={statusMeta.badgeClass}>{statusMeta.label}</Badge>
              <Badge className={cn("border", priority.badgeClass)}>
                优先级 · {priority.label}
              </Badge>
              {task.parent_task_id ? (
                <Badge variant="outline">子任务</Badge>
              ) : null}
            </div>
            <h1 className="text-xl leading-snug font-semibold break-words">
              {task.title}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canEdit ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditOpen(true)}
              >
                <PencilIcon />
                编辑
              </Button>
            ) : null}
            {canRelease ? (
              <Button
                variant="outline"
                size="sm"
                disabled={actionPending}
                onClick={() => runAction(() => releaseTask.mutateAsync(undefined))}
              >
                <UnlockIcon />
                释放任务
              </Button>
            ) : null}
            {canReopen ? (
              <Button
                variant="outline"
                size="sm"
                disabled={actionPending}
                onClick={() => runAction(() => reopenTask.mutateAsync(undefined))}
              >
                <RotateCcwIcon />
                重新打开
              </Button>
            ) : null}
            {canCancel ? (
              <Button
                variant="destructive"
                size="sm"
                disabled={actionPending}
                onClick={() => setCancelOpen(true)}
              >
                <CircleSlashIcon />
                取消任务
              </Button>
            ) : null}
          </div>
        </div>

        {actionError ? (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        ) : null}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="任务说明">
            {task.description ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {task.description}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">未填写说明。</p>
            )}
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">
                验收条件
              </h3>
              {task.acceptance_criteria ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {task.acceptance_criteria}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">未填写验收条件。</p>
              )}
            </div>
          </Section>

          {task.progress_note || task.progress_percent_estimate != null ? (
            <Section title="执行进度">
              {task.progress_percent_estimate != null ? (
                <div className="flex items-center gap-3">
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={task.progress_percent_estimate}
                    aria-label="AI 估计进度"
                    className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-indigo-500"
                      style={{ width: `${task.progress_percent_estimate}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {task.progress_percent_estimate}%（AI 估计）
                  </span>
                </div>
              ) : null}
              {task.progress_note ? (
                <p className="text-sm whitespace-pre-wrap">{task.progress_note}</p>
              ) : null}
            </Section>
          ) : null}

          <Section title="结果与附件">
            {task.status === "cancelled" ? (
              <p className="text-xs text-muted-foreground">
                已取消的任务不能上传新附件。
              </p>
            ) : (
              <ArtifactUpload taskId={task.id} />
            )}
            {task.result_summary ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {task.result_summary}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">暂无结果摘要。</p>
            )}
            {task.result_json != null ? (
              <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(task.result_json, null, 2)}
              </pre>
            ) : null}
            {artifacts.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {artifacts.map((artifact) => (
                  <ArtifactItem key={artifact.id} artifact={artifact} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">暂无附件。</p>
            )}
          </Section>

          <Section
            title={
              pendingStructuredRequest || pendingQuestion
                ? "消息（AI 正在等待你的回复）"
                : "消息"
            }
          >
            {pendingStructuredRequest ? (
              <StructuredUserInputForm
                request={pendingStructuredRequest}
                sourceTaskTitle={
                  pendingStructuredRequest.task_id === task.id
                    ? null
                    : (knownTaskById.get(pendingStructuredRequest.task_id)
                        ?.title ?? pendingStructuredRequest.task_id)
                }
              />
            ) : null}
            {sortedMessages.length > 0 ? (
              <ol className="flex flex-col gap-3">
                {sortedMessages.map((message) => (
                  <li
                    key={message.id}
                    className={cn(
                      "flex flex-col gap-1 rounded-md border px-3 py-2",
                      message.sender_type === "user"
                        ? "border-indigo-200 bg-indigo-50/60"
                        : message.sender_type === "ai"
                          ? "border-teal-200 bg-teal-50/60"
                          : "border-border bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="font-medium">
                        {ACTOR_TYPE_LABEL[message.sender_type]}
                      </span>
                      <time
                        dateTime={message.created_at}
                        title={formatDateTime(message.created_at)}
                      >
                        {formatRelativeTime(message.created_at)}
                      </time>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">
                      {message.content}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">暂无消息。</p>
            )}

            {!pendingStructuredRequest ? (
            <form onSubmit={onSendMessage} className="flex flex-col gap-2">
              {isDescendantQuestion && pendingQuestion ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                  该问题来自等待中的子任务
                  <Link
                    href={`/tasks/${pendingQuestion.task_id}`}
                    className="mx-1 font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    「{pendingQuestionTask?.title ?? pendingQuestion.task_id}」
                  </Link>
                  。你可以在此直接回复，回复将发送给该子任务并恢复到原会话的预留队列。
                </p>
              ) : null}
              <Textarea
                aria-label={pendingQuestion ? "回复 AI 的问题" : "发送消息"}
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                placeholder={
                  pendingQuestion
                    ? "回复后任务将回到原会话的预留队列…"
                    : "给执行该任务的 AI 留言…"
                }
              />
              <Button
                type="submit"
                size="sm"
                className="self-end"
                disabled={
                  replyToTask.isPending ||
                  postMessage.isPending ||
                  !composer.trim()
                }
              >
                <SendIcon />
                {pendingQuestion ? "回复并恢复任务" : "发送"}
              </Button>
            </form>
            ) : (
              <p className="text-xs text-muted-foreground">
                当前问题必须通过上方选择框提交；普通留言会在回答后恢复。
              </p>
            )}
          </Section>

          <Section title="事件时间线">
            {sortedEvents.length > 0 ? (
              <ol className="relative flex flex-col gap-3 border-l border-border pl-4">
                {sortedEvents.map((event) => (
                  <li key={event.id} className="relative flex flex-col gap-0.5">
                    <span
                      aria-hidden
                      className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-muted-foreground/50"
                    />
                    <span className="text-sm font-medium">
                      {eventTypeLabel(event.type)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {ACTOR_TYPE_LABEL[event.actor_type]} ·{" "}
                      <time dateTime={event.created_at}>
                        {formatDateTime(event.created_at)}
                      </time>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">暂无事件记录。</p>
            )}
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Section
            title="层级与依赖"
            action={
              canAddSubtask ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSubtaskOpen(true)}
                >
                  <PlusIcon />
                  子任务
                </Button>
              ) : undefined
            }
          >
            {subtaskBlockReason ? (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                {subtaskBlockReason}
              </p>
            ) : null}
            {children.length > 0 ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                子任务完成 {doneChildren} / {children.length}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">父任务</h3>
              {parent ? (
                <TaskLink task={parent} />
              ) : (
                <p className="text-sm text-muted-foreground">无（根任务）</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">子任务</h3>
              {children.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {children.map((child) => (
                    <TaskLink key={child.id} task={child} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">没有子任务。</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                依赖任务
              </h3>
              {dependencies.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {dependencies.map((dependency) => (
                    <TaskLink key={dependency.id} task={dependency} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">无直接依赖。</p>
              )}
            </div>
          </Section>

          <Section title="会话绑定与租约">
            <dl className="flex flex-col gap-3">
              <KeyValue label="当前会话">
                {claimedSession
                  ? `${claimedSession.platform} · ${claimedSession.name}`
                  : assignedSession
                    ? `已指定：${assignedSession.platform} · ${assignedSession.name}`
                    : "未指定"}
              </KeyValue>
              <KeyValue label="会话接收时间">
                {formatDateTime(task.claimed_at)}
              </KeyValue>
              <KeyValue label="租约到期">
                {task.lease_expires_at ? (
                  <span>
                    {formatDateTime(task.lease_expires_at)}
                    {isPast(task.lease_expires_at) ? "（已过期）" : ""}
                  </span>
                ) : (
                  "—"
                )}
              </KeyValue>
              <KeyValue label="最后心跳">
                {formatDateTime(claimedSession?.last_seen_at)}
              </KeyValue>
            </dl>
          </Section>

          <Section title="属性">
            <dl className="flex flex-col gap-3">
              <KeyValue label="所需能力">
                {task.required_capabilities.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {task.required_capabilities.map((capability) => (
                      <Badge key={capability} variant="secondary">
                        {capability}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "无要求"
                )}
              </KeyValue>
              <KeyValue label="创建者">
                {ACTOR_TYPE_LABEL[task.created_by_type]}
              </KeyValue>
              <KeyValue label="创建时间">
                {formatDateTime(task.created_at)}
              </KeyValue>
              <KeyValue label="最后更新">
                {formatDateTime(task.updated_at)}
              </KeyValue>
              {task.completed_at ? (
                <KeyValue label="完成时间">
                  {formatDateTime(task.completed_at)}
                </KeyValue>
              ) : null}
              {task.external_source || task.external_task_ref ? (
                <KeyValue label="外部引用">
                  {[task.external_source, task.external_task_ref]
                    .filter(Boolean)
                    .join(" · ")}
                </KeyValue>
              ) : null}
            </dl>
          </Section>
        </div>
      </div>

      <TaskFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        task={task}
        hasChildren={children.length > 0}
      />
      <SubtaskDialog
        open={subtaskOpen}
        onOpenChange={setSubtaskOpen}
        parentTask={task}
        siblings={children}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="取消该任务？"
        description="取消后任务进入“已取消”状态，其未完成的后代任务也会一并取消。该操作不可撤销，已取消的任务无法再重新打开。"
        confirmLabel="确认取消"
        destructive
        pending={cancelTask.isPending}
        onConfirm={() =>
          runAction(async () => {
            await cancelTask.mutateAsync(undefined);
            setCancelOpen(false);
          })
        }
      />
    </div>
  );
}

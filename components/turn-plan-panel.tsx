"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CirclePlayIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LoadingBlock } from "@/components/states";
import { SESSION_STATUS_META, TASK_STATUS_META } from "@/components/task-meta";
import { turnPlansQueryKey } from "@/hooks/query-keys";
import {
  useCreateTurnPlanStep,
  useDeleteTurnPlanStep,
  useDispatchTurnPlanChain,
  useTurnPlanSteps,
  useUpdateTurnPlanStep,
} from "@/hooks/use-planning";
import { useCancelTask } from "@/hooks/use-tasks";
import {
  agentModelOptions,
  compatibleReasoningEffort,
  reasoningEffortLabel,
} from "@/lib/codex-models";
import {
  effectiveSessionStatus,
  isSessionAlive,
} from "@/lib/domain/session-presence";
import type { TurnPlanStep } from "@/lib/types/domain";
import type { SessionListItem } from "@/lib/types/domain";

const INHERIT_THREAD_SETTING = "__inherit__";
const TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled", "failed"]);

function firstLine(content: string): string {
  return content.split("\n").find((line) => line.trim())?.trim() ?? "";
}

/** 已派发步骤是只读执行记录；行内取消走现有的任务取消接口。 */
function DispatchedStepRow({
  step,
  index,
  onCancel,
}: {
  step: TurnPlanStep;
  index: number;
  onCancel: (step: TurnPlanStep) => void;
}) {
  const taskStatus = step.dispatched_task_status;
  const statusMeta = taskStatus ? TASK_STATUS_META[taskStatus] : null;
  const cancellable =
    taskStatus === "ready" || taskStatus === "blocked" || taskStatus === "paused";
  return (
    <li className="flex items-start gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
      <span className="mt-0.5 w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {index + 1}.
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{firstLine(step.content)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {step.model ?? "跟随 Thread 模型"}
          {step.reasoning_effort ? ` · ${step.reasoning_effort}` : ""}
        </p>
      </div>
      {statusMeta ? (
        <Badge variant="outline" className={statusMeta.badgeClass}>
          {statusMeta.label}
        </Badge>
      ) : (
        <Badge variant="outline" className="border-stone-200 bg-stone-100 text-stone-500">
          已取消
        </Badge>
      )}
      {cancellable && step.dispatched_task_id ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => onCancel(step)}
          aria-label={`取消第 ${index + 1} 步`}
        >
          取消
        </Button>
      ) : null}
    </li>
  );
}

/** useCancelTask 按 taskId 绑定，所以取消确认框需要挂在步骤级组件里。 */
function CancelStepDialog({
  step,
  sessionId,
  open,
  onOpenChange,
}: {
  step: TurnPlanStep;
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const cancelTask = useCancelTask(step.dispatched_task_id ?? "");
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (!step.dispatched_task_id) return;
    setError(null);
    try {
      await cancelTask.mutateAsync({});
      void queryClient.invalidateQueries({
        queryKey: turnPlansQueryKey(sessionId),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消失败，请稍后重试");
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="取消这个排队中的 Turn？"
      description="任务会被标记为已取消；链中后续步骤将保持阻塞，可单独取消或等待处理。"
      confirmLabel="取消 Turn"
      destructive
      pending={cancelTask.isPending}
      onConfirm={() => void onConfirm()}
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

export function TurnPlanPanel({ session }: { session: SessionListItem }) {
  const stepsQuery = useTurnPlanSteps(session.id);
  const createStep = useCreateTurnPlanStep(session.id);
  const updateStep = useUpdateTurnPlanStep(session.id);
  const deleteStep = useDeleteTurnPlanStep(session.id);
  const dispatchChain = useDispatchTurnPlanChain(session.id);

  const [newContent, setNewContent] = useState("");
  const [model, setModel] = useState(INHERIT_THREAD_SETTING);
  const [effort, setEffort] = useState(INHERIT_THREAD_SETTING);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [deletingStep, setDeletingStep] = useState<TurnPlanStep | null>(null);
  const [cancellingStep, setCancellingStep] = useState<TurnPlanStep | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const steps = stepsQuery.data ?? [];
  const drafts = steps.filter((step) => step.status === "draft");
  const dispatched = steps.filter((step) => step.status === "dispatched");
  const alive = isSessionAlive(session);
  const sessionStatus = SESSION_STATUS_META[effectiveSessionStatus(session)];
  const chainActive = dispatched.some(
    (step) =>
      step.dispatched_task_status !== null &&
      !TERMINAL_TASK_STATUSES.has(step.dispatched_task_status),
  );

  const modelOptions = agentModelOptions(
    session.connection.model_catalog,
    session.platform,
  );
  const selectedModel = modelOptions.find((option) => option.value === model);
  const availableEfforts = selectedModel?.efforts ?? [];

  const onModelChange = (value: string) => {
    setModel(value);
    if (value === INHERIT_THREAD_SETTING) {
      setEffort(INHERIT_THREAD_SETTING);
      return;
    }
    setEffort((current) =>
      current === INHERIT_THREAD_SETTING
        ? current
        : compatibleReasoningEffort(value, current, modelOptions),
    );
  };

  const onAddStep = async () => {
    const content = newContent.trim();
    if (!content) return;
    setActionError(null);
    try {
      await createStep.mutateAsync({
        content,
        model: model === INHERIT_THREAD_SETTING ? null : model,
        reasoning_effort: effort === INHERIT_THREAD_SETTING ? null : effort,
      });
      setNewContent("");
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "添加失败，请稍后重试",
      );
    }
  };

  const onMoveStep = async (step: TurnPlanStep, direction: -1 | 1) => {
    const index = drafts.findIndex((candidate) => candidate.id === step.id);
    const neighbor = drafts[index + direction];
    if (!neighbor) return;
    setActionError(null);
    try {
      await updateStep.mutateAsync({
        stepId: step.id,
        position: neighbor.position,
      });
      await updateStep.mutateAsync({
        stepId: neighbor.id,
        position: step.position,
      });
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "调整顺序失败，请稍后重试",
      );
    }
  };

  const onSaveEditing = async () => {
    if (!editingId) return;
    const content = editingContent.trim();
    if (!content) return;
    setActionError(null);
    try {
      await updateStep.mutateAsync({ stepId: editingId, content });
      setEditingId(null);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "保存失败，请稍后重试",
      );
    }
  };

  const onDispatch = async () => {
    setActionError(null);
    try {
      await dispatchChain.mutateAsync();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "派发失败，请稍后重试",
      );
    }
  };

  const onConfirmDelete = async () => {
    if (!deletingStep) return;
    setActionError(null);
    try {
      await deleteStep.mutateAsync(deletingStep.id);
      setDeletingStep(null);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "删除失败，请稍后重试",
      );
    }
  };

  return (
    <section
      aria-label={`Thread「${session.name}」的 Turn 规划`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            Turn 规划链
            <Badge variant="outline" className={sessionStatus.badgeClass}>
              {sessionStatus.label}
            </Badge>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            按顺序规划给「{session.name}
            」的多个 Turn；派发后前一个完成会自动触发下一个。
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={
            drafts.length === 0 || !alive || dispatchChain.isPending
          }
          title={
            !alive
              ? "Thread 离线，无法派发"
              : drafts.length === 0
                ? "先添加规划步骤"
                : undefined
          }
          onClick={() => void onDispatch()}
        >
          <CirclePlayIcon className="size-4" />
          {dispatchChain.isPending
            ? "派发中…"
            : chainActive
              ? `追加执行 ${drafts.length} 个步骤`
              : `开始执行 ${drafts.length} 个步骤`}
        </Button>
      </header>

      {stepsQuery.isLoading ? (
        <LoadingBlock label="加载 Turn 规划…" />
      ) : (
        <>
          {dispatched.length > 0 ? (
            <ol className="flex flex-col gap-1.5" aria-label="已派发步骤">
              {dispatched.map((step, index) => (
                <DispatchedStepRow
                  key={step.id}
                  step={step}
                  index={index}
                  onCancel={setCancellingStep}
                />
              ))}
            </ol>
          ) : null}

          {drafts.length > 0 ? (
            <ol className="flex flex-col gap-1.5" aria-label="草稿步骤">
              {drafts.map((step, index) => (
                <li
                  key={step.id}
                  className="flex items-start gap-3 rounded-md border border-dashed border-border px-3 py-2"
                >
                  <span className="mt-0.5 w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {dispatched.length + index + 1}.
                  </span>
                  {editingId === step.id ? (
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <Textarea
                        aria-label={`编辑第 ${dispatched.length + index + 1} 步`}
                        value={editingContent}
                        onChange={(event) =>
                          setEditingContent(event.target.value)
                        }
                        className="min-h-24 text-sm leading-6"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={
                            updateStep.isPending || !editingContent.trim()
                          }
                          onClick={() => void onSaveEditing()}
                        >
                          保存
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap break-words text-sm">
                          {step.content}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {step.model ?? "跟随 Thread 模型"}
                          {step.reasoning_effort
                            ? ` · ${step.reasoning_effort}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={index === 0 || updateStep.isPending}
                          aria-label="上移一步"
                          title="上移"
                          onClick={() => void onMoveStep(step, -1)}
                        >
                          <ArrowUpIcon className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={
                            index === drafts.length - 1 || updateStep.isPending
                          }
                          aria-label="下移一步"
                          title="下移"
                          onClick={() => void onMoveStep(step, 1)}
                        >
                          <ArrowDownIcon className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="编辑这一步"
                          title="编辑"
                          onClick={() => {
                            setEditingId(step.id);
                            setEditingContent(step.content);
                          }}
                        >
                          <PencilIcon className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 text-destructive"
                          aria-label="删除这一步"
                          title="删除"
                          onClick={() => setDeletingStep(step)}
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ol>
          ) : dispatched.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              还没有规划步骤。在下面写出第一个 Turn 要交给 AI 的任务。
            </p>
          ) : null}

          <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
            <Textarea
              aria-label="新规划步骤内容"
              value={newContent}
              onChange={(event) => setNewContent(event.target.value)}
              placeholder="下一步要 AI 做什么？写清楚目标、上下文和验收标准。"
              className="min-h-20 bg-card text-sm leading-6"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select value={model} onValueChange={onModelChange}>
                <SelectTrigger
                  className="h-8 w-44 text-xs"
                  aria-label="这一步的模型"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_THREAD_SETTING}>
                    跟随 Thread 模型
                  </SelectItem>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={effort}
                onValueChange={setEffort}
                disabled={model === INHERIT_THREAD_SETTING}
              >
                <SelectTrigger
                  className="h-8 w-40 text-xs"
                  aria-label="这一步的思考强度"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_THREAD_SETTING}>
                    模型默认强度
                  </SelectItem>
                  {availableEfforts.map((value) => (
                    <SelectItem key={value} value={value}>
                      {reasoningEffortLabel(
                        value,
                        selectedModel?.effortDescriptions[value],
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="ml-auto"
                disabled={createStep.isPending || !newContent.trim()}
                onClick={() => void onAddStep()}
              >
                <PlusIcon className="size-4" />
                {createStep.isPending ? "添加中…" : "添加步骤"}
              </Button>
            </div>
          </div>
        </>
      )}

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <ConfirmDialog
        open={deletingStep !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingStep(null);
        }}
        title="删除这个规划步骤？"
        description={`「${firstLine(deletingStep?.content ?? "").slice(0, 80)}」将从规划中移除，未派发的内容不会保留。`}
        confirmLabel="删除步骤"
        destructive
        pending={deleteStep.isPending}
        onConfirm={() => void onConfirmDelete()}
      />

      {cancellingStep ? (
        <CancelStepDialog
          step={cancellingStep}
          sessionId={session.id}
          open
          onOpenChange={(open) => {
            if (!open) setCancellingStep(null);
          }}
        />
      ) : null}
    </section>
  );
}

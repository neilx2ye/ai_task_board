"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatRelativeTime } from "@/components/utils";
import { PRIORITY_LEVELS } from "@/components/task-meta";
import { useSessions } from "@/hooks/use-sessions";
import {
  isSessionSelectLocked,
  resolveAssignedSessionPatch,
  sessionOptionsForStatus,
} from "@/hooks/task-assignment";
import {
  useCreateTask,
  useUpdateTask,
  type TaskInput,
} from "@/hooks/use-tasks";
import { isSessionAlive } from "@/lib/domain/session-presence";
import type { TaskRow } from "@/lib/types/database";

const UNASSIGNED = "__none__";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入则为编辑模式，否则为新建。 */
  task?: TaskRow | null;
  /** 被编辑任务是否已有子任务（聚合父任务指派规则）。新建恒为 false。 */
  hasChildren?: boolean;
  /** 从某张会话卡片发起时预选并锁定该会话。 */
  initialSessionId?: string | null;
  lockInitialSession?: boolean;
};

function parseCapabilities(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 新建 / 编辑任务对话框。只提交用户可编辑字段，状态由服务端规则管理。 */
export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  hasChildren = false,
  initialSessionId = null,
  lockInitialSession = false,
}: Props) {
  const isEdit = Boolean(task);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑任务" : "新建任务"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "任务始终绑定到具体 AI 会话及其已有上下文。"
              : "把任务预留给一个存活的 AI 会话；它不会进入公共认领池。"}
          </DialogDescription>
        </DialogHeader>
        {/* 表单随 DialogContent 一起卸载，每次打开都以 task 重新初始化 */}
        <TaskForm
          key={task?.id ?? `new:${initialSessionId ?? "unselected"}`}
          task={task ?? null}
          hasChildren={hasChildren}
          initialSessionId={initialSessionId}
          lockInitialSession={lockInitialSession}
          onDone={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function TaskForm({
  task,
  hasChildren,
  initialSessionId,
  lockInitialSession,
  onDone,
  onCancel,
}: {
  task: TaskRow | null;
  hasChildren: boolean;
  initialSessionId: string | null;
  lockInitialSession: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const isEdit = Boolean(task);
  const createTask = useCreateTask();
  const updateTask = useUpdateTask(task?.id ?? "");
  const { data: sessions } = useSessions();

  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [acceptance, setAcceptance] = useState(task?.acceptance_criteria ?? "");
  const [priority, setPriority] = useState(String(task?.priority ?? 50));
  const [capabilities, setCapabilities] = useState(
    (task?.required_capabilities ?? []).join(", "),
  );
  const [assignedSessionId, setAssignedSessionId] = useState(
    task?.assigned_session_id ?? initialSessionId ?? UNASSIGNED,
  );
  const [error, setError] = useState<string | null>(null);

  const pending = createTask.isPending || updateTask.isPending;

  const taskStatus = task?.status ?? "inbox";
  const originalSessionId = task?.assigned_session_id ?? null;
  const assignmentContext = {
    isEdit,
    status: taskStatus,
    hasChildren,
    original: originalSessionId,
  };
  const sessionLocked =
    isSessionSelectLocked(assignmentContext) || (!isEdit && lockInitialSession);
  const restrictedOptions = sessionOptionsForStatus(assignmentContext);
  const candidateSessions = (sessions ?? []).filter(
    (session) =>
      isSessionAlive(session) ||
      (isEdit && session.id === task?.assigned_session_id),
  );
  const selectableSessions = restrictedOptions
    ? candidateSessions.filter((session) => restrictedOptions.includes(session.id))
    : candidateSessions;
  const selectedSession = (sessions ?? []).find(
    (session) => session.id === assignedSessionId,
  );
  const hasTargetSession =
    assignedSessionId !== UNASSIGNED &&
    Boolean(selectedSession) &&
    (isEdit || Boolean(selectedSession && isSessionAlive(selectedSession)));

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!isEdit && !hasTargetSession) {
      setError("请选择一个近期有心跳的 AI 会话");
      return;
    }

    const assignment = resolveAssignedSessionPatch({
      ...assignmentContext,
      selected: assignedSessionId === UNASSIGNED ? null : assignedSessionId,
    });

    const payload: TaskInput = {
      title: title.trim(),
      description: description.trim() || null,
      acceptance_criteria: acceptance.trim() || null,
      priority: Number(priority),
      required_capabilities: parseCapabilities(capabilities),
    };
    if (assignment.include) {
      payload.assigned_session_id = assignment.value;
    }

    try {
      if (isEdit && task) {
        await updateTask.mutateAsync(payload);
      } else {
        await createTask.mutateAsync(payload);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败，请稍后重试");
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-title">标题</Label>
        <Input
          id="task-title"
          required
          maxLength={500}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：收集竞品名单"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-description">说明</Label>
        <Textarea
          id="task-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="任务背景、范围与要求"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-acceptance">验收条件</Label>
        <Textarea
          id="task-acceptance"
          value={acceptance}
          onChange={(event) => setAcceptance(event.target.value)}
          placeholder="如何判断任务已完成"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-priority">优先级</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger id="task-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_LEVELS.map((level) => (
                <SelectItem key={level.value} value={String(level.value)}>
                  {level.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-session">
            目标 AI 会话{isEdit ? "" : "（必选）"}
          </Label>
          <Select
            value={assignedSessionId}
            onValueChange={setAssignedSessionId}
            disabled={sessionLocked}
          >
            <SelectTrigger id="task-session">
              <SelectValue placeholder="选择存活会话" />
            </SelectTrigger>
            <SelectContent>
              {assignedSessionId === UNASSIGNED ? (
                <SelectItem value={UNASSIGNED} disabled>
                  请选择存活会话
                </SelectItem>
              ) : null}
              {selectableSessions.map((session) => (
                <SelectItem key={session.id} value={session.id}>
                  {session.platform} · {session.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sessionLocked ? (
            <p className="text-xs text-muted-foreground">
              {!isEdit && lockInitialSession
                ? "任务将预留给你刚才选择的会话。"
                : hasChildren
                ? "包含子任务的聚合任务不能指定 AI 会话。"
                : "任务正在由 AI 执行，会话指派已锁定。"}
            </p>
          ) : restrictedOptions ? (
            <p className="text-xs text-muted-foreground">
              {hasChildren
                ? "该任务包含子任务，只能保持当前会话。"
                : "等待回复期间保持原会话，避免丢失提问上下文。"}
            </p>
          ) : selectableSessions.length === 0 ? (
            <p className="text-xs text-destructive">
              暂无存活会话。请先让 CLI 或 APP 注册会话并持续发送心跳。
            </p>
          ) : null}
        </div>
      </div>

      {selectedSession ? (
        <div className="rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-950">
          <p className="font-medium">沿用此会话的上下文</p>
          <p className="mt-1 text-indigo-800">
            {selectedSession.platform} · {selectedSession.name}
            {selectedSession.model ? ` · ${selectedSession.model}` : ""}
            {` · 最后活动 ${formatRelativeTime(selectedSession.last_seen_at)}`}
          </p>
          {selectedSession.external_conversation_ref ? (
            <p className="mt-1 truncate text-indigo-700">
              对话引用：{selectedSession.external_conversation_ref}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-capabilities">所需能力</Label>
        <Input
          id="task-capabilities"
          value={capabilities}
          onChange={(event) => setCapabilities(event.target.value)}
          placeholder="以逗号分隔，例如：web_search, coding"
        />
        <p className="text-xs text-muted-foreground">
          可选校验；任务不会因此改派给其他会话。
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button
          type="submit"
          disabled={pending || !title.trim() || (!isEdit && !hasTargetSession)}
        >
          {pending ? "保存中…" : isEdit ? "保存修改" : "预留任务"}
        </Button>
      </DialogFooter>
    </form>
  );
}

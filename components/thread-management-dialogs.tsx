"use client";

import { useState, type FormEvent } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
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
import {
  useCreateThread,
  useDeleteThread,
  useDeleteThreads,
  useRenameThread,
} from "@/hooks/use-sessions";
import {
  agentModelOptions,
  compatibleReasoningEffort,
  defaultCodexModel,
  reasoningEffortLabel,
} from "@/lib/codex-models";
import { agentDisplayName } from "@/lib/agent-platforms";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";

const INHERIT_AGENT_SETTING = "__inherit__";

export function CreateThreadDialog({
  connection,
  directoryKey,
  directoryName,
  workingDirectory,
  open,
  onOpenChange,
  onSubmitted,
}: {
  connection: SessionConnectionSummary;
  directoryKey: string | null;
  directoryName: string | null;
  workingDirectory: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: (input: { name: string }) => void;
}) {
  const createThread = useCreateThread(connection.id);
  const [name, setName] = useState("");
  const agentName = agentDisplayName(connection.platform);
  const modelOptions = agentModelOptions(
    connection.model_catalog,
    connection.platform,
  );
  const initialModel = modelOptions.length
    ? defaultCodexModel(modelOptions)
    : INHERIT_AGENT_SETTING;
  const initialModelOption = modelOptions.find(
    (option) => option.value === initialModel,
  );
  const [model, setModel] = useState(initialModel);
  const [reasoningEffort, setReasoningEffort] = useState<string>(
    initialModel === INHERIT_AGENT_SETTING
      ? INHERIT_AGENT_SETTING
      : compatibleReasoningEffort(
          initialModel,
          initialModelOption?.defaultEffort,
          modelOptions,
        ),
  );
  const [error, setError] = useState<string | null>(null);

  const selectedModel = modelOptions.find(
    (option) => option.value === model,
  );
  const availableEfforts =
    selectedModel?.efforts ?? [];

  const onModelChange = (value: string) => {
    setModel(value);
    if (value === INHERIT_AGENT_SETTING) {
      setReasoningEffort(INHERIT_AGENT_SETTING);
      return;
    }
    if (reasoningEffort !== INHERIT_AGENT_SETTING) {
      setReasoningEffort(
        compatibleReasoningEffort(value, reasoningEffort, modelOptions),
      );
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const submittedName = name.trim();
    try {
      await createThread.mutateAsync({
        name: submittedName,
        directory_key: directoryKey,
        model: model === INHERIT_AGENT_SETTING ? null : model,
        reasoning_effort:
          reasoningEffort === INHERIT_AGENT_SETTING
            ? null
            : reasoningEffort,
      });
      onOpenChange(false);
      onSubmitted({ name: submittedName });
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败，请稍后重试");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新建 Thread</DialogTitle>
          <DialogDescription>
            请求会发送给「{connection.name}」上的 {agentName} Bridge，并在本机创建真实
            Thread
            {directoryName ? `，归入「${directoryName}」` : ""}。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`new-thread-${connection.id}`}>Thread 名称</Label>
            <Input
              id={`new-thread-${connection.id}`}
              required
              autoFocus
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：修复登录流程"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`new-thread-model-${connection.id}`}>模型</Label>
              <Select value={model} onValueChange={onModelChange}>
                <SelectTrigger id={`new-thread-model-${connection.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_AGENT_SETTING}>
                    使用 {agentName} 默认
                  </SelectItem>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`new-thread-effort-${connection.id}`}>
                思考强度
              </Label>
              <Select
                value={reasoningEffort}
                onValueChange={setReasoningEffort}
              >
                <SelectTrigger id={`new-thread-effort-${connection.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_AGENT_SETTING}>
                    使用模型默认
                  </SelectItem>
                  {availableEfforts.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {reasoningEffortLabel(
                        effort,
                        selectedModel?.effortDescriptions[effort],
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {selectedModel?.description ??
              `模型与思考强度由运行 Bridge 的 ${agentName} 配置决定。`}
            {reasoningEffort === INHERIT_AGENT_SETTING
              ? " 思考强度继承模型默认值。"
              : " 更高强度通常需要更多时间和用量。"}
          </p>
          <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            工作目录：{workingDirectory ?? "使用 Bridge 的默认本机工作目录"}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={createThread.isPending || !name.trim()}
            >
              {createThread.isPending ? "提交中…" : "创建 Thread"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameThreadDialog({
  session,
  open,
  onOpenChange,
  onSubmitted,
}: {
  session: SessionListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
}) {
  const renameThread = useRenameThread(session.id);
  const agentName = agentDisplayName(
    session.connection?.platform ?? session.platform,
  );
  const [name, setName] = useState(session.name);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await renameThread.mutateAsync({ name: name.trim() });
      onOpenChange(false);
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "改名失败，请稍后重试");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>重命名 Thread</DialogTitle>
          <DialogDescription>
            新名称会立即用于 Web Console，并由 Bridge 同步到本机 {agentName}。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rename-thread-${session.id}`}>Thread 名称</Label>
            <Input
              id={`rename-thread-${session.id}`}
              required
              autoFocus
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                renameThread.isPending ||
                !name.trim() ||
                name.trim() === session.name
              }
            >
              {renameThread.isPending ? "提交中…" : "保存名称"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteThreadDialog({
  session,
  open,
  onOpenChange,
  onSubmitted,
}: {
  session: SessionListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
}) {
  const deleteThread = useDeleteThread(session.id);
  const agentName = agentDisplayName(
    session.connection?.platform ?? session.platform,
  );
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    setError(null);
    try {
      await deleteThread.mutateAsync();
      onOpenChange(false);
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败，请稍后重试");
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`删除 Thread「${session.name}」？`}
      description={`Thread 会立即从 Web Console 隐藏，并由在线 Bridge 从本机 ${agentName} 删除。看板中的关联审计数据会保留。此操作无法在 Console 中恢复。`}
      confirmLabel="删除 Thread"
      destructive
      pending={deleteThread.isPending}
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

export function DeleteUnselectedThreadsDialog({
  sessions,
  projectName,
  skippedCount,
  open,
  onOpenChange,
  onSubmitted,
}: {
  sessions: SessionListItem[];
  projectName: string;
  skippedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: (deletedCount: number) => void;
}) {
  const deleteThreads = useDeleteThreads();
  const agentName = agentDisplayName(
    sessions[0]?.connection?.platform ?? sessions[0]?.platform,
  );
  const [remainingSessions, setRemainingSessions] = useState(sessions);
  const [deletedCount, setDeletedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    setError(null);
    try {
      const result = await deleteThreads.mutateAsync(remainingSessions);
      const nextDeletedCount = deletedCount + result.deletedIds.length;

      if (result.failures.length > 0) {
        const failedIds = new Set(result.failures.map((failure) => failure.id));
        setRemainingSessions((current) =>
          current.filter((session) => failedIds.has(session.id)),
        );
        setDeletedCount(nextDeletedCount);
        setError(
          `${result.failures.length} 个 Thread 删除失败：${result.failures
            .map((failure) => `「${failure.name}」${failure.message}`)
            .join("；")}`,
        );
        return;
      }

      onOpenChange(false);
      onSubmitted(nextDeletedCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批量删除失败，请稍后重试");
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`删除 ${remainingSessions.length} 个未勾选 Thread？`}
      description={`这些 Thread 属于项目「${projectName}」。它们会立即从 Web Console 隐藏，并由在线 Bridge 从本机 ${agentName} 删除；看板中的关联审计数据会保留。${
        skippedCount > 0
          ? ` 另有 ${skippedCount} 个未勾选 Thread 因有任务或已离开设备清单而不会删除。`
          : ""
      }`}
      confirmLabel={
        deletedCount > 0
          ? `重试删除剩余 ${remainingSessions.length} 个`
          : `删除 ${remainingSessions.length} 个 Thread`
      }
      destructive
      pending={deleteThreads.isPending}
      onConfirm={() => void onConfirm()}
    >
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
        <p className="mb-1.5 text-xs font-medium text-foreground">将删除：</p>
        <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
          {remainingSessions.map((session) => (
            <li key={session.id} className="break-words">
              {session.name}
            </li>
          ))}
        </ul>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

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
  useCreateThread,
  useDeleteThread,
  useDeleteThreads,
  useRenameThread,
} from "@/hooks/use-sessions";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";

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
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const submittedName = name.trim();
    try {
      await createThread.mutateAsync({
        name: submittedName,
        directory_key: directoryKey,
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
            请求会发送给「{connection.name}」上的 Codex Bridge，并在本机创建真实
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
            新名称会立即用于 Web Console，并由 Bridge 同步到本机 Codex。
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
      description="Thread 会立即从 Web Console 隐藏，并由在线 Bridge 从本机 Codex 删除。看板中的关联审计数据会保留。此操作无法在 Console 中恢复。"
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
      description={`这些 Thread 属于项目「${projectName}」。它们会立即从 Web Console 隐藏，并由在线 Bridge 从本机 Codex 删除；看板中的关联审计数据会保留。${
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

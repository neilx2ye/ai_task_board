"use client";

import { useState, type FormEvent } from "react";

import { PRIORITY_LEVELS } from "@/components/task-meta";
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
import { useSessions } from "@/hooks/use-sessions";
import { useCreateSubtasks } from "@/hooks/use-tasks";
import { isSessionAlive } from "@/lib/domain/session-presence";
import type { TaskRow } from "@/lib/types/database";

const UNSELECTED_SESSION = "__unselected_session__";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentTask: TaskRow;
  /** 父任务下已有的子任务，可作为新子任务的依赖。 */
  siblings: TaskRow[];
};

/** 为当前任务添加一个子任务，可选依赖已有子任务。 */
export function SubtaskDialog({ open, onOpenChange, parentTask, siblings }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加子任务</DialogTitle>
          <DialogDescription>
            在「{parentTask.title}」下创建子任务，并预留给一个已有上下文的存活会话。
          </DialogDescription>
        </DialogHeader>
        {/* 表单随 DialogContent 一起卸载，每次打开都是全新表单 */}
        <SubtaskForm
          parentTask={parentTask}
          siblings={siblings}
          onDone={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function SubtaskForm({
  parentTask,
  siblings,
  onDone,
  onCancel,
}: {
  parentTask: TaskRow;
  siblings: TaskRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const createSubtasks = useCreateSubtasks(parentTask.id);
  const { data: sessions } = useSessions();
  const liveSessions = (sessions ?? []).filter((session) => isSessionAlive(session));
  const inheritedSessionId = liveSessions.some(
    (session) => session.id === parentTask.assigned_session_id,
  )
    ? parentTask.assigned_session_id
    : null;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("50");
  const [assignedSessionId, setAssignedSessionId] = useState(
    inheritedSessionId ?? UNSELECTED_SESSION,
  );
  const [dependsOn, setDependsOn] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const toggleDependency = (taskId: string) => {
    setDependsOn((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (assignedSessionId === UNSELECTED_SESSION) {
      setError("请选择一个存活的 AI 会话");
      return;
    }
    try {
      await createSubtasks.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        priority: Number(priority),
        assigned_session_id: assignedSessionId,
        depends_on_task_ids: [...dependsOn],
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败，请稍后重试");
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="subtask-title">标题</Label>
        <Input
          id="subtask-title"
          required
          maxLength={500}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="subtask-description">说明</Label>
        <Textarea
          id="subtask-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="subtask-session">目标 AI 会话（必选）</Label>
        <Select
          value={assignedSessionId}
          onValueChange={setAssignedSessionId}
        >
          <SelectTrigger id="subtask-session">
            <SelectValue placeholder="选择存活会话" />
          </SelectTrigger>
          <SelectContent>
            {assignedSessionId === UNSELECTED_SESSION ? (
              <SelectItem value={UNSELECTED_SESSION} disabled>
                请选择存活会话
              </SelectItem>
            ) : null}
            {liveSessions.map((session) => (
              <SelectItem key={session.id} value={session.id}>
                {session.platform} · {session.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {liveSessions.length === 0 ? (
          <p className="text-xs text-destructive">
            暂无存活会话，不能创建未绑定的子任务。
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            子任务只会出现在所选会话的预留队列中。
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="subtask-priority">优先级</Label>
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger id="subtask-priority">
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

      {siblings.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">依赖的子任务</legend>
          <p className="text-xs text-muted-foreground">
            新任务会在所选子任务完成后才会出现在目标会话的预留队列中。
          </p>
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
            {siblings.map((sibling) => (
              <label
                key={sibling.id}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-secondary"
              >
                <input
                  type="checkbox"
                  checked={dependsOn.has(sibling.id)}
                  onChange={() => toggleDependency(sibling.id)}
                  className="size-4 accent-indigo-600"
                />
                <span className="min-w-0 flex-1 truncate">{sibling.title}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

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
          disabled={
            createSubtasks.isPending ||
            !title.trim() ||
            assignedSessionId === UNSELECTED_SESSION
          }
        >
          {createSubtasks.isPending ? "创建中…" : "创建子任务"}
        </Button>
      </DialogFooter>
    </form>
  );
}

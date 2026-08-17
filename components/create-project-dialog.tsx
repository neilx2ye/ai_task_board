"use client";

import { useMemo, useState, type FormEvent } from "react";

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
import { apiFetch } from "@/hooks/api-client";
import {
  supportsManagedDirectoryCreation,
  type PublicConnection,
} from "@/hooks/use-connections";
import { groupConnectionsByDevice } from "@/lib/domain/device-groups";
import {
  directoryNameFromPath,
  sessionProjectIdForDirectory,
} from "@/lib/domain/session-directory-groups";
import type {
  CreateProjectResponse,
  ProjectDispatchResult,
} from "@/lib/types/database";

function summarizeResults(results: ProjectDispatchResult[]): string {
  const submitted = results.filter((result) => result.status === "submitted");
  const skipped = results.filter((result) => result.status === "skipped");
  const failed = results.filter((result) => result.status === "failed");
  const parts = [
    `已下发给 ${submitted.length} 个 Bridge：${submitted
      .map((result) => result.connection_name)
      .join("、")}。`,
  ];
  if (skipped.length > 0) {
    parts.push(
      `跳过 ${skipped.length} 个：${skipped
        .map((result) => `${result.connection_name}（${result.reason}）`)
        .join("、")}。`,
    );
  }
  if (failed.length > 0) {
    parts.push(
      `失败 ${failed.length} 个：${failed
        .map((result) => `${result.connection_name}（${result.reason}）`)
        .join("、")}。`,
    );
  }
  parts.push("Bridge 应用并同步后，新项目会自动出现在 Tab 链中。");
  return parts.join("");
}

/**
 * Web 创建项目：选定设备后，把新项目目录（含 create_if_missing 授权）
 * 下发到该设备上所有支持托管目录创建的 Bridge。
 */
export function CreateProjectDialog({
  connections,
  open,
  onOpenChange,
  onCreated,
}: {
  connections: PublicConnection[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string, summary: string) => void;
}) {
  const deviceGroups = useMemo(
    () =>
      groupConnectionsByDevice(connections).map((group) => {
        const capable = group.connections.filter((connection) =>
          supportsManagedDirectoryCreation(connection),
        );
        return { ...group, capable };
      }),
    [connections],
  );
  const creatableGroups = deviceGroups.filter(
    (group) => group.capable.length > 0,
  );

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 每次打开对话框固定一个幂等键，失败重试沿用同一键。
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );

  const selectedGroup =
    creatableGroups.find((group) => group.deviceId === deviceId) ?? null;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const path = workingDirectory.trim();
    const projectName = name.trim() || directoryNameFromPath(path);
    if (!selectedGroup) {
      setError("请选择一台设备");
      return;
    }
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(path)) {
      setError("项目路径必须是绝对路径");
      return;
    }

    setSubmitting(true);
    try {
      const { results } = await apiFetch<CreateProjectResponse>(
        "/api/user/projects",
        {
          method: "POST",
          json: {
            name: projectName,
            working_directory: path,
            connection_ids: selectedGroup.capable.map(
              (connection) => connection.id,
            ),
          },
          idempotencyKey,
        },
      );
      const submitted = results.filter(
        (result) => result.status === "submitted",
      );
      if (submitted.length === 0) {
        setError(summarizeResults(results));
        return;
      }
      onOpenChange(false);
      onCreated(
        sessionProjectIdForDirectory({ workingDirectory: path }),
        summarizeResults(results),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setIdempotencyKey(crypto.randomUUID());
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>
            选择一台设备并输入项目路径，该设备上所有支持托管目录的 Bridge
            都会关联到该项目（目录不存在时由设备自动创建）。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-device">设备</Label>
            <Select
              value={deviceId ?? ""}
              onValueChange={(value) => setDeviceId(value)}
            >
              <SelectTrigger id="create-project-device">
                <SelectValue placeholder="选择设备" />
              </SelectTrigger>
              <SelectContent>
                {creatableGroups.map((group) => (
                  <SelectItem key={group.deviceId} value={group.deviceId}>
                    {group.label}（{group.capable.length}/
                    {group.connections.length} 个 Bridge 可创建）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {creatableGroups.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                暂无可用的设备：需要 Bridge 1.3.0 及以上版本，并在设备上允许
                Web 工作目录配置。
              </p>
            ) : null}
            {selectedGroup &&
            selectedGroup.capable.length <
              selectedGroup.connections.length ? (
              <p className="text-xs text-muted-foreground">
                该设备上有{" "}
                {selectedGroup.connections.length -
                  selectedGroup.capable.length}{" "}
                个 Bridge 版本过低，需升级到 1.3.0 后才能关联新项目。
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-path">项目路径（绝对路径）</Label>
            <Input
              id="create-project-path"
              value={workingDirectory}
              onChange={(event) => {
                const value = event.target.value;
                setWorkingDirectory(value);
                if (!nameTouched) {
                  setName(directoryNameFromPath(value.trim()));
                }
              }}
              placeholder="/home/user/projects/my-app"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-name">项目名称</Label>
            <Input
              id="create-project-name"
              value={name}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
              placeholder="默认取路径最后一段"
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
              disabled={submitting || creatableGroups.length === 0}
            >
              {submitting ? "下发中…" : "创建项目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

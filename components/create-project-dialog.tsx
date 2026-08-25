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
import { connectionPlatformLabel } from "@/lib/agent-platforms";
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
 * Web 创建项目：选定一个 Bridge，把新项目目录（含 create_if_missing 授权）
 * 下发到该 Bridge 所在设备上所有支持托管目录创建的 Bridge。
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
    () => groupConnectionsByDevice(connections),
    [connections],
  );
  // 选项按用户认识的 Bridge 连接名展示；设备由选中的 Bridge 推断。
  const bridgeOptions = useMemo(
    () =>
      [...connections]
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
        .map((connection) => ({
          connection,
          capable: supportsManagedDirectoryCreation(connection),
        })),
    [connections],
  );
  const hasCapableBridge = bridgeOptions.some((option) => option.capable);

  const [bridgeId, setBridgeId] = useState<string | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 每次打开对话框固定一个幂等键，失败重试沿用同一键。
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );

  const selectedDevice = useMemo(() => {
    if (!bridgeId) return null;
    const group = deviceGroups.find((candidate) =>
      candidate.connections.some((connection) => connection.id === bridgeId),
    );
    if (!group) return null;
    const capable = group.connections.filter((connection) =>
      supportsManagedDirectoryCreation(connection),
    );
    const outdated = group.connections.filter(
      (connection) => !supportsManagedDirectoryCreation(connection),
    );
    return { group, capable, outdated };
  }, [bridgeId, deviceGroups]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const path = workingDirectory.trim();
    const projectName = name.trim() || directoryNameFromPath(path);
    if (!selectedDevice || selectedDevice.capable.length === 0) {
      setError("请选择一个 Bridge");
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
            connection_ids: selectedDevice.capable.map(
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
            选择一个 Bridge，新项目会关联到它所在设备的所有 Bridge（目录不存在时由设备自动创建）。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-bridge">Bridge</Label>
            <Select
              value={bridgeId ?? ""}
              onValueChange={(value) => setBridgeId(value)}
            >
              <SelectTrigger id="create-project-bridge">
                <SelectValue placeholder="选择 Bridge" />
              </SelectTrigger>
              <SelectContent>
                {bridgeOptions.map(({ connection, capable }) => (
                  <SelectItem
                    key={connection.id}
                    value={connection.id}
                    disabled={!capable}
                  >
                    {connection.name}（{connectionPlatformLabel(connection.platform)}）
                    {capable ? "" : " · 需升级 1.3.0"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!hasCapableBridge ? (
              <p className="text-xs text-muted-foreground">
                暂无可用的 Bridge：需要 1.3.0 及以上版本，并在设备上允许
                Web 工作目录配置。
              </p>
            ) : null}
            {selectedDevice ? (
              <div className="text-xs text-muted-foreground">
                <p>
                  将关联到该设备的 {selectedDevice.capable.length} 个 Bridge：
                  {selectedDevice.capable
                    .map((connection) => connection.name)
                    .join("、")}
                  。
                </p>
                {selectedDevice.outdated.length > 0 ? (
                  <p className="mt-0.5">
                    {selectedDevice.outdated
                      .map((connection) => connection.name)
                      .join("、")}{" "}
                    版本过低，升级到 1.3.0 后才会关联新项目。
                  </p>
                ) : null}
              </div>
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
            <Button type="submit" disabled={submitting || !hasCapableBridge}>
              {submitting ? "下发中…" : "创建项目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

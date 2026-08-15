"use client";

import { useState, type FormEvent } from "react";
import {
  CableIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";

import { BridgeConfigDialog } from "@/components/bridge-config-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { TokenDisplayDialog } from "@/components/token-display-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
  activeConnections,
  useConnections,
  useCreateConnection,
  useRenameConnection,
  useRevokeConnection,
  useRotateConnection,
  type ConnectionWithToken,
  type PublicConnection,
} from "@/hooks/use-connections";
import { supportsBridgeSettings } from "@/hooks/use-bridge-config";
import { formatDateTime, formatRelativeTime } from "@/components/utils";

const SUPPORTED_CONNECTION_PLATFORMS = ["Codex", "Kimi Code", "Antigravity"];

function RenameConnectionDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: PublicConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const renameConnection = useRenameConnection(connection.id);
  const [name, setName] = useState(connection.name);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await renameConnection.mutateAsync({ name: name.trim() });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "改名失败，请稍后重试");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>重命名 AI 连接</DialogTitle>
          <DialogDescription>
            新名称会同步显示在 AI 连接页和会话设备列表中。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rename-connection-${connection.id}`}>名称</Label>
            <Input
              id={`rename-connection-${connection.id}`}
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
                renameConnection.isPending ||
                !name.trim() ||
                name.trim() === connection.name
              }
            >
              {renameConnection.isPending ? "保存中…" : "保存名称"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateConnectionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: ConnectionWithToken) => void;
}) {
  const createConnection = useCreateConnection();
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState(
    SUPPORTED_CONNECTION_PLATFORMS[0],
  );
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      const result = await createConnection.mutateAsync({
        name: name.trim(),
        platform,
      });
      onOpenChange(false);
      setName("");
      onCreated(result);
      // 明文令牌只交给一次性弹窗状态，立即从 MutationCache 清除。
      createConnection.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败，请稍后重试");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新建 AI 连接</DialogTitle>
          <DialogDescription>
            连接令牌只会在创建成功后显示一次，数据库仅保存其哈希值。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="connection-name">名称</Label>
            <Input
              id="connection-name"
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的 Codex 设备"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="connection-platform">平台</Label>
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger id="connection-platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_CONNECTION_PLATFORMS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              disabled={createConnection.isPending || !name.trim()}
            >
              {createConnection.isPending ? "创建中…" : "创建并生成令牌"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionCard({
  connection,
  onToken,
}: {
  connection: PublicConnection;
  onToken: (result: ConnectionWithToken) => void;
}) {
  const rotateConnection = useRotateConnection(connection.id);
  const revokeConnection = useRevokeConnection(connection.id);
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [bridgeConfigOpen, setBridgeConfigOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = rotateConnection.isPending || revokeConnection.isPending;
  const hasBridgeSettings = supportsBridgeSettings(connection);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请稍后重试");
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-semibold">
            {connection.name}
          </span>
          <span className="text-xs text-muted-foreground">
            {connection.platform}
          </span>
        </div>
        <Badge className="border border-teal-200 bg-teal-50 text-teal-700">
          有效
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <div>
            创建于：
            <time dateTime={connection.created_at}>
              {formatDateTime(connection.created_at)}
            </time>
          </div>
          <div>
            最近使用：
            {connection.last_used_at ? (
              <time dateTime={connection.last_used_at}>
                {formatRelativeTime(connection.last_used_at)}
              </time>
            ) : (
              "从未使用"
            )}
          </div>
        </dl>

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setRenameOpen(true)}
          >
            <PencilIcon />
            重命名
          </Button>
          {hasBridgeSettings ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setBridgeConfigOpen(true)}
            >
              <Settings2Icon />
              Bridge 设置
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setConfirm("rotate")}
          >
            <RefreshCwIcon />
            轮换令牌
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => setConfirm("revoke")}
          >
            <Trash2Icon />
            撤销
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirm === "rotate"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="轮换连接令牌？"
        description="旧令牌会立即失效，使用旧令牌的 AI 客户端将无法再调用接口。新令牌只显示一次。"
        confirmLabel="轮换并生成新令牌"
        pending={rotateConnection.isPending}
        onConfirm={() =>
          run(async () => {
            const result = await rotateConnection.mutateAsync(undefined);
            setConfirm(null);
            onToken(result);
            // 明文令牌只交给一次性弹窗状态，立即从 MutationCache 清除。
            rotateConnection.reset();
          })
        }
      />
      {renameOpen ? (
        <RenameConnectionDialog
          connection={connection}
          open
          onOpenChange={setRenameOpen}
        />
      ) : null}
      <ConfirmDialog
        open={confirm === "revoke"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="撤销该连接？"
        description="撤销后连接令牌立即失效，关联的 AI 会话将无法继续操作。该操作不可恢复。"
        confirmLabel="确认撤销"
        destructive
        pending={revokeConnection.isPending}
        onConfirm={() =>
          run(async () => {
            await revokeConnection.mutateAsync(undefined);
            setConfirm(null);
          })
        }
      />
      {hasBridgeSettings ? (
        <BridgeConfigDialog
          connection={connection}
          open={bridgeConfigOpen}
          onOpenChange={setBridgeConfigOpen}
        />
      ) : null}
    </Card>
  );
}

export default function ConnectionsPage() {
  const connectionsQuery = useConnections();
  const [createOpen, setCreateOpen] = useState(false);
  const [tokenResult, setTokenResult] = useState<ConnectionWithToken | null>(
    null,
  );
  // 防御性过滤：即使缓存中残留已撤销连接也不渲染。
  const connections = activeConnections(connectionsQuery.data ?? []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">AI 连接</h1>
          <p className="text-sm text-muted-foreground">
            为每个 AI 客户端创建接入连接，客户端凭令牌调用 REST API 或 MCP。
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon />
          新建连接
        </Button>
      </div>

      {connectionsQuery.error ? (
        <ErrorState
          message={connectionsQuery.error.message}
          onRetry={() => void connectionsQuery.refetch()}
        />
      ) : connectionsQuery.isLoading ? (
        <LoadingBlock label="加载 AI 连接…" />
      ) : connections.length === 0 ? (
        <EmptyState
          icon={<CableIcon className="size-6" />}
          title="还没有 AI 连接"
          description="创建 Codex、Kimi Code 或 Antigravity 连接，再把令牌配置到对应 Bridge 中即可接入看板。"
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              新建连接
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              onToken={setTokenResult}
            />
          ))}
        </div>
      )}

      <CreateConnectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setTokenResult}
      />
      <TokenDisplayDialog
        token={tokenResult?.token ?? null}
        connectionName={tokenResult?.connection.name ?? ""}
        onClose={() => setTokenResult(null)}
      />
    </div>
  );
}

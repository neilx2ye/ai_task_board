"use client";

import { useId, useState, type FormEvent } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, Clock3Icon } from "lucide-react";

import { formatDateTime } from "@/components/utils";
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
import { ApiError } from "@/hooks/api-client";
import {
  bridgeConfigSyncState,
  bridgeSupportsHistorySync,
  bridgeSupportsRemoteConfiguration,
  useBridgeConfig,
  useUpdateBridgeConfig,
  type BridgeConfigConstraints,
  type BridgeConfigSyncState,
  type BridgeConfiguration,
  type BridgeDesiredConfig,
} from "@/hooks/use-bridge-config";

type BridgeConnection = {
  id: string;
  name: string;
  bridge_version: string | null;
};

export const BRIDGE_HISTORY_RETENTION_NOTICE =
  "关闭历史同步或降低 Turn 上限，只会停止或收窄后续导入，不会删除已经上传的历史。";

const STATUS_COPY: Record<
  BridgeConfigSyncState,
  { label: string; description: string; className: string }
> = {
  "upgrade-required": {
    label: "需要升级 Bridge",
    description:
      "期望配置可以保存，但设备尚未上报远程配置能力；升级 Bridge 后才可能生效。",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  offline: {
    label: "Bridge 离线",
    description:
      "设备当前没有有效的运行租约；下方实际值是最后一次成功上报，不代表仍在运行。",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
  waiting: {
    label: "等待 Bridge 应用",
    description: "期望配置已保存，正在等待设备拉取并回报实际生效值。",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  error: {
    label: "Bridge 应用失败",
    description: "设备已回报错误。修正配置或设备状态后可再次保存。",
    className: "border-red-200 bg-red-50 text-red-700",
  },
  "remote-disabled": {
    label: "本机禁止 Web 配置",
    description:
      "期望值已保存在看板，但设备的本地安全边界不允许远程配置，因此不会应用。",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  applied: {
    label: "已应用",
    description: "Bridge 回报的实际生效值与当前期望配置一致。",
    className: "border-teal-200 bg-teal-50 text-teal-700",
  },
  constrained: {
    label: "已应用（受本机约束）",
    description:
      "Bridge 已处理当前版本，但实际值被设备上的安全上限收紧。",
    className: "border-sky-200 bg-sky-50 text-sky-700",
  },
};

function yesNo(value: boolean): string {
  return value ? "开启" : "关闭";
}

function scopeLabel(constraints: BridgeConfigConstraints): string {
  if (constraints.fixed_thread) return "固定单个 thread";
  return constraints.thread_scope === "cwd" ? "当前项目（cwd）" : "整台设备";
}

function permissionLabel(mode: BridgeConfigConstraints["permission_mode"]): string {
  return mode === "safe" ? "安全模式" : "继承本机设置";
}

function approvalLabel(mode: BridgeConfigConstraints["approval_mode"]): string {
  if (mode === "decline") return "自动拒绝";
  if (mode === "accept-session") return "当前会话内允许";
  return "自动允许";
}

function ConfigStatus({
  configuration,
  bridgeVersion,
}: {
  configuration: BridgeConfiguration;
  bridgeVersion: string | null;
}) {
  const state = bridgeConfigSyncState(configuration, bridgeVersion);
  const copy = STATUS_COPY[state];
  const Icon =
    state === "applied"
      ? CheckCircle2Icon
      : state === "waiting"
        ? Clock3Icon
        : AlertTriangleIcon;

  return (
    <div className={`rounded-md border px-3 py-2 ${copy.className}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 shrink-0" />
        {copy.label}
      </div>
      <p className="mt-1 text-xs leading-relaxed">{copy.description}</p>
      <p className="mt-1 text-[11px] opacity-80">
        期望版本 {configuration.version} · Bridge 回报版本{" "}
        {configuration.applied?.version ?? "—"}
      </p>
      {configuration.runtime.lease_expires_at ? (
        <p className="mt-1 text-[11px] opacity-80">
          运行租约至{" "}
          <time dateTime={configuration.runtime.lease_expires_at}>
            {formatDateTime(configuration.runtime.lease_expires_at)}
          </time>
        </p>
      ) : null}
      {configuration.applied?.error ? (
        <p
          role={state === "error" ? "alert" : undefined}
          className="mt-2 break-words text-xs font-medium"
        >
          {configuration.applied.error}
        </p>
      ) : null}
    </div>
  );
}

function EffectiveValues({
  desired,
  effective,
  reported,
}: {
  desired: BridgeDesiredConfig;
  effective: BridgeDesiredConfig | null;
  reported: boolean;
}) {
  const rows = [
    [
      "Bridge",
      yesNo(desired.enabled),
      effective ? yesNo(effective.enabled) : "等待上报",
    ],
    [
      "Thread 标题",
      yesNo(desired.include_thread_titles),
      effective ? yesNo(effective.include_thread_titles) : "等待上报",
    ],
    [
      "Thread 数",
      String(desired.max_threads),
      effective ? String(effective.max_threads) : "等待上报",
    ],
    [
      "并行 Turn",
      String(desired.max_concurrent_turns),
      effective ? String(effective.max_concurrent_turns) : "等待上报",
    ],
    [
      "Codex 历史同步",
      yesNo(desired.sync_history ?? false),
      effective ? yesNo(effective.sync_history ?? false) : "等待上报",
    ],
    [
      "最近历史 Turn",
      String(desired.history_turn_limit ?? 50),
      effective ? String(effective.history_turn_limit ?? 50) : "等待上报",
    ],
  ];

  return (
    <div className="overflow-hidden rounded-md border border-border text-xs">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 bg-muted px-3 py-2 font-medium">
        <span>配置项</span>
        <span>期望值</span>
        <span>{reported ? "实际生效" : "Bridge 上报"}</span>
      </div>
      {rows.map(([label, desiredValue, effectiveValue]) => (
        <div
          key={label}
          className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 border-t border-border px-3 py-2"
        >
          <span className="min-w-0 text-muted-foreground">{label}</span>
          <span>{desiredValue}</span>
          <span>{effectiveValue}</span>
        </div>
      ))}
    </div>
  );
}

function LocalConstraints({
  constraints,
}: {
  constraints: BridgeConfigConstraints | null;
}) {
  if (!constraints) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
        设备尚未上报项目范围和本地安全上限。这里不会推测配置已经生效。
      </div>
    );
  }

  return (
    <dl className="grid gap-x-4 gap-y-2 rounded-md border border-border p-3 text-xs sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">项目范围</dt>
        <dd className="mt-0.5 font-medium">{scopeLabel(constraints)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">工作目录</dt>
        <dd className="mt-0.5 break-all font-mono text-[11px]">
          {constraints.working_directory || "—"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">本机数量上限</dt>
        <dd className="mt-0.5 font-medium">
          {constraints.max_threads} threads · {constraints.max_concurrent_turns}{" "}
          turns
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Web 配置入口</dt>
        <dd className="mt-0.5 font-medium">
          {constraints.remote_configuration_enabled ? "本机允许" : "本机禁止"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">标题上传上限</dt>
        <dd className="mt-0.5 font-medium">
          {constraints.allow_thread_titles ? "本机允许" : "本机禁止"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">历史同步上限</dt>
        <dd className="mt-0.5 font-medium">
          {constraints.allow_history_sync
            ? `本机允许 · 最多 ${constraints.max_history_turns} turns`
            : "本机未授权"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">工具权限（只读）</dt>
        <dd className="mt-0.5 font-medium">
          {permissionLabel(constraints.permission_mode)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">审批策略（只读）</dt>
        <dd className="mt-0.5 font-medium">
          {approvalLabel(constraints.approval_mode)}
        </dd>
      </div>
    </dl>
  );
}

function BridgeConfigForm({
  connection,
  configuration,
  onConflict,
  onSubmitStart,
}: {
  connection: BridgeConnection;
  configuration: BridgeConfiguration;
  onConflict: () => Promise<unknown>;
  onSubmitStart: () => void;
}) {
  const fieldId = useId();
  const updateConfig = useUpdateBridgeConfig(connection.id);
  const [enabled, setEnabled] = useState(configuration.desired.enabled);
  const [includeTitles, setIncludeTitles] = useState(
    configuration.desired.include_thread_titles,
  );
  const [maxThreads, setMaxThreads] = useState(
    String(configuration.desired.max_threads),
  );
  const [maxConcurrentTurns, setMaxConcurrentTurns] = useState(
    String(configuration.desired.max_concurrent_turns),
  );
  const [syncHistory, setSyncHistory] = useState(
    configuration.desired.sync_history ?? false,
  );
  const [historyTurnLimit, setHistoryTurnLimit] = useState(
    String(configuration.desired.history_turn_limit ?? 50),
  );
  const [error, setError] = useState<string | null>(null);

  const constraints = configuration.applied?.constraints ?? null;
  const titleUploadBlocked = constraints?.allow_thread_titles === false;
  // A locally blocked device must still let the Owner turn an already-saved
  // desired value off; only enabling the disclosure is forbidden.
  const titleToggleDisabled = titleUploadBlocked && !includeTitles;
  const historySupported = bridgeSupportsHistorySync(connection.bridge_version);
  const historySyncBlocked = constraints?.allow_history_sync !== true;
  // Keep an already-saved opt-in reversible even after a device removes its
  // local authorization or temporarily reports from an older Bridge.
  const historyToggleDisabled =
    (!historySupported || historySyncBlocked) && !syncHistory;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    onSubmitStart();

    const parsedMaxThreads = Number(maxThreads);
    const parsedMaxConcurrentTurns = Number(maxConcurrentTurns);
    const parsedHistoryTurnLimit = Number(historyTurnLimit);
    if (
      !Number.isInteger(parsedMaxThreads) ||
      parsedMaxThreads < 1 ||
      parsedMaxThreads > 500
    ) {
      setError("最大 Thread 数必须是 1 到 500 之间的整数");
      return;
    }
    if (
      !Number.isInteger(parsedHistoryTurnLimit) ||
      parsedHistoryTurnLimit < 1 ||
      parsedHistoryTurnLimit > 500
    ) {
      setError("最近历史 Turn 数必须是 1 到 500 之间的整数");
      return;
    }
    if (
      !Number.isInteger(parsedMaxConcurrentTurns) ||
      parsedMaxConcurrentTurns < 1 ||
      parsedMaxConcurrentTurns > 32
    ) {
      setError("最大并行 Turn 数必须是 1 到 32 之间的整数");
      return;
    }

    try {
      await updateConfig.mutateAsync({
        expected_version: configuration.version,
        enabled,
        include_thread_titles: includeTitles,
        max_threads: parsedMaxThreads,
        max_concurrent_turns: parsedMaxConcurrentTurns,
        sync_history: syncHistory,
        history_turn_limit: parsedHistoryTurnLimit,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        try {
          await onConflict();
        } catch (refreshError) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : "配置版本冲突，刷新失败，请稍后重试",
          );
        }
        return;
      }
      setError(err instanceof Error ? err.message : "保存失败，请稍后重试");
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <ConfigStatus
        configuration={configuration}
        bridgeVersion={connection.bridge_version}
      />

      <EffectiveValues
        desired={configuration.desired}
        effective={configuration.applied?.effective ?? null}
        reported={bridgeSupportsRemoteConfiguration(connection.bridge_version)}
      />

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">期望配置</legend>
        <label
          htmlFor={`${fieldId}-enabled`}
          className="flex cursor-pointer items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5"
        >
          <span>
            <span className="block text-sm font-medium">Bridge 启用</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              关闭后设备仍可心跳和接收配置，但不会启动新的 Web Turn。
            </span>
          </span>
          <input
            id={`${fieldId}-enabled`}
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-indigo-600"
          />
        </label>

        <label
          htmlFor={`${fieldId}-history`}
          className={`flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5 ${
            historyToggleDisabled
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer"
          }`}
        >
          <span>
            <span className="block text-sm font-medium">同步 Codex Thread 历史</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-amber-700">
              会上传最近的用户消息、AI 回复和可展示思考摘要；当前 Workspace
              的所有成员都可以查看，且必须先在设备上明确授权。
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              {BRIDGE_HISTORY_RETENTION_NOTICE}
            </span>
            {!historySupported ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                需要 Bridge 0.4.0 或更高版本。
              </span>
            ) : historySyncBlocked ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                {constraints
                  ? "本机尚未允许历史同步；需在设备设置 CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true。"
                  : "等待设备上报本机历史同步授权；需先设置 CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true。"}
              </span>
            ) : null}
          </span>
          <input
            id={`${fieldId}-history`}
            type="checkbox"
            role="switch"
            checked={syncHistory}
            disabled={historyToggleDisabled}
            onChange={(event) => setSyncHistory(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-indigo-600"
          />
        </label>

        <label
          htmlFor={`${fieldId}-titles`}
          className={`flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5 ${
            titleToggleDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
          }`}
        >
          <span>
            <span className="block text-sm font-medium">上传 Thread 标题</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-amber-700">
              标题可能包含首条提示词预览；启用后会上传到当前 Workspace。
            </span>
          </span>
          <input
            id={`${fieldId}-titles`}
            type="checkbox"
            role="switch"
            checked={includeTitles}
            disabled={titleToggleDisabled}
            onChange={(event) => setIncludeTitles(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-indigo-600"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${fieldId}-threads`}>最大 Thread 数</Label>
            <Input
              id={`${fieldId}-threads`}
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={500}
              step={1}
              value={maxThreads}
              onChange={(event) => setMaxThreads(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Web 上限 500；本机上限
              {constraints ? ` ${constraints.max_threads}` : "尚未上报"}。
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${fieldId}-turns`}>最大并行 Turn 数</Label>
            <Input
              id={`${fieldId}-turns`}
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={32}
              step={1}
              value={maxConcurrentTurns}
              onChange={(event) => setMaxConcurrentTurns(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Web 上限 32；本机上限
              {constraints ? ` ${constraints.max_concurrent_turns}` : "尚未上报"}。
            </p>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor={`${fieldId}-history-turns`}>
              同步最近 Turn 数
            </Label>
            <Input
              id={`${fieldId}-history-turns`}
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={500}
              step={1}
              value={historyTurnLimit}
              onChange={(event) => setHistoryTurnLimit(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Web 最多请求最近 500 个 Turn；本机上限
              {constraints
                ? ` ${constraints.max_history_turns}`
                : "尚未上报"}
              。关闭历史同步时保留此期望值。
            </p>
          </div>
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">设备本地安全边界</h3>
        <LocalConstraints constraints={constraints} />
      </div>

      {configuration.applied ? (
        <p className="text-xs text-muted-foreground">
          最近上报：
          <time dateTime={configuration.applied.applied_at}>
            {formatDateTime(configuration.applied.applied_at)}
          </time>
          {connection.bridge_version
            ? ` · Bridge ${connection.bridge_version}`
            : ""}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={updateConfig.isPending}>
          {updateConfig.isPending ? "保存中…" : "保存期望配置"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function BridgeConfigDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: BridgeConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const configQuery = useBridgeConfig(connection.id, open);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) setConflictNotice(null);
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bridge 设置 · {connection.name}</DialogTitle>
          <DialogDescription>
            Web 只保存期望值；设备会在本地安全边界内应用，并回报实际值。
          </DialogDescription>
        </DialogHeader>

        {configQuery.isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            加载 Bridge 配置…
          </div>
        ) : configQuery.error ? (
          <div className="flex flex-col items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3">
            <p role="alert" className="text-sm text-red-700">
              {configQuery.error.message}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void configQuery.refetch()}
            >
              重试
            </Button>
          </div>
        ) : configQuery.data ? (
          <>
            {conflictNotice ? (
              <p
                role="alert"
                className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              >
                {conflictNotice}
              </p>
            ) : null}
            <BridgeConfigForm
              key={configQuery.data.configuration.version}
              connection={connection}
              configuration={configQuery.data.configuration}
              onSubmitStart={() => setConflictNotice(null)}
              onConflict={async () => {
                const result = await configQuery.refetch();
                setConflictNotice(
                  "配置已由其他窗口更新；已载入最新值，请确认后重新保存。",
                );
                return result;
              }}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

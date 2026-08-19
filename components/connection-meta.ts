import {
  canonicalBridgeKind,
  isUnifiedPlatform,
} from "@/lib/agent-platforms";

/**
 * 设备（AI 连接）的视觉标识：按连接 id 稳定分配一组颜色，
 * 让侧边栏里的设备与并排打开的 Thread 窗口能一眼对上号。
 */

export type ConnectionColorMeta = {
  /** 圆点（侧边栏设备名、设备徽标内）。 */
  dotClass: string;
  /** 设备徽标：浅色底 + 深色字，与 task-meta 的状态徽标同风格。 */
  badgeClass: string;
  /** Thread 窗口顶部标识条。 */
  barClass: string;
};

const CONNECTION_COLOR_PALETTE: readonly ConnectionColorMeta[] = [
  {
    dotClass: "bg-indigo-500",
    badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-700",
    barClass: "bg-indigo-400",
  },
  {
    dotClass: "bg-teal-500",
    badgeClass: "border-teal-200 bg-teal-50 text-teal-700",
    barClass: "bg-teal-400",
  },
  {
    dotClass: "bg-sky-500",
    badgeClass: "border-sky-200 bg-sky-50 text-sky-700",
    barClass: "bg-sky-400",
  },
  {
    dotClass: "bg-emerald-500",
    badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
    barClass: "bg-emerald-400",
  },
  {
    dotClass: "bg-amber-500",
    badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
    barClass: "bg-amber-400",
  },
  {
    dotClass: "bg-violet-500",
    badgeClass: "border-violet-200 bg-violet-50 text-violet-700",
    barClass: "bg-violet-400",
  },
  {
    dotClass: "bg-rose-500",
    badgeClass: "border-rose-200 bg-rose-50 text-rose-700",
    barClass: "bg-rose-400",
  },
  {
    dotClass: "bg-cyan-500",
    badgeClass: "border-cyan-200 bg-cyan-50 text-cyan-700",
    barClass: "bg-cyan-400",
  },
];

export const CONNECTION_COLOR_COUNT = CONNECTION_COLOR_PALETTE.length;

/**
 * 统一设备连接上每种 Bridge 运行时使用的固定调色索引。
 * 四种 CLI 各占一种稳定颜色，同一台设备上也不会互相混淆。
 */
const BRIDGE_RUNTIME_COLOR_INDEX: Readonly<Record<string, number>> = {
  codex: 0,
  kimi: 1,
  antigravity: 2,
  claude: 4,
};

/** 按规范运行时类型返回固定颜色；未知类型返回 null，由调用方回退。 */
export function runtimeColorMeta(
  runtimePlatform: string | null | undefined,
): ConnectionColorMeta | null {
  const kind = runtimePlatform?.trim()
    ? canonicalBridgeKind(runtimePlatform)
    : "";
  const index = BRIDGE_RUNTIME_COLOR_INDEX[kind];
  return index === undefined ? null : CONNECTION_COLOR_PALETTE[index];
}

/**
 * 连接/运行时分组的展示色：统一设备连接按运行时固定取色，
 * 其它连接保持按连接 id 稳定散列，未知运行时回退到连接色。
 */
export function connectionRuntimeColorMeta(
  connectionId: string | null | undefined,
  connectionPlatform: string | null | undefined,
  runtimePlatform: string | null | undefined = null,
): ConnectionColorMeta {
  if (isUnifiedPlatform(connectionPlatform)) {
    const runtime = runtimeColorMeta(runtimePlatform);
    if (runtime) return runtime;
  }
  return connectionColorMeta(connectionId);
}

/** djb2-xor 散列：同一连接 id 永远落在同一颜色上，跨页面、跨会话稳定。 */
function connectionColorIndex(connectionId: string): number {
  let hash = 5381;
  for (let index = 0; index < connectionId.length; index += 1) {
    hash = ((hash * 33) ^ connectionId.charCodeAt(index)) >>> 0;
  }
  return hash % CONNECTION_COLOR_PALETTE.length;
}

export function connectionColorMeta(
  connectionId: string | null | undefined,
): ConnectionColorMeta {
  return CONNECTION_COLOR_PALETTE[connectionColorIndex(connectionId ?? "")];
}

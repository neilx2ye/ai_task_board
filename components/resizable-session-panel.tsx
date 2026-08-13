"use client";

import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { SessionConversationPanel } from "@/components/session-conversation-dialog";
import { cn } from "@/components/utils";
import type { SessionListItem } from "@/lib/types/domain";

const MIN_PANEL_WIDTH = 320;
const PANEL_VIEWPORT_GUTTER = 32;

export function clampConversationPanelWidth(
  width: number,
  viewportWidth: number,
): number {
  const maximum = Math.max(0, viewportWidth - PANEL_VIEWPORT_GUTTER);
  const minimum = Math.min(MIN_PANEL_WIDTH, maximum);
  return Math.min(maximum, Math.max(minimum, width));
}

type ResizeState = {
  pointerId: number;
  lastX: number;
  width: number;
};

type PanelStyle = CSSProperties & {
  "--conversation-panel-width"?: string;
};

/** 桌面端可独立调宽；未调宽的面板继续均分剩余空间。 */
export function ResizableSessionPanel({
  session,
  onClose,
}: {
  session: SessionListItem;
  onClose: () => void;
}) {
  const [width, setWidth] = useState<number | null>(null);
  const resizeState = useRef<ResizeState | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const measuredWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ??
      MIN_PANEL_WIDTH;
    resizeState.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      width: measuredWidth,
    };
    setWidth(measuredWidth);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = resizeState.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = event.clientX - current.lastX;
    current.lastX = event.clientX;
    current.width = clampConversationPanelWidth(
      current.width + delta,
      window.innerWidth,
    );
    setWidth(current.width);
    event.preventDefault();
  };

  const finishResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    resizeState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const measuredWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ??
      width ??
      MIN_PANEL_WIDTH;
    setWidth(
      clampConversationPanelWidth(
        measuredWidth + (event.key === "ArrowRight" ? 32 : -32),
        window.innerWidth,
      ),
    );
    event.preventDefault();
  };

  const style: PanelStyle | undefined =
    width === null
      ? undefined
      : { "--conversation-panel-width": `${width}px` };

  return (
    <div
      className={cn(
        "relative min-w-0 flex-1 lg:h-full lg:min-w-80",
        width !== null &&
          "lg:w-[var(--conversation-panel-width)] lg:flex-none",
      )}
      style={style}
    >
      <SessionConversationPanel
        session={session}
        onClose={onClose}
        className="min-w-0"
      />
      <button
        type="button"
        aria-label={`调整会话「${session.name}」窗口宽度`}
        title="拖拽或使用左右方向键调整宽度；双击恢复自动宽度"
        className="group absolute inset-y-0 right-0 z-20 hidden w-3 cursor-ew-resize touch-none items-center justify-center outline-none hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 lg:flex"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={() => {
          resizeState.current = null;
        }}
        onDoubleClick={() => setWidth(null)}
        onKeyDown={onKeyDown}
      >
        <span className="h-12 w-1 rounded-full bg-border transition-colors group-hover:bg-muted-foreground/60 group-focus-visible:bg-muted-foreground/60" />
      </button>
    </div>
  );
}

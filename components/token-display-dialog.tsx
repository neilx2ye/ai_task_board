"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  /** 非空时展示令牌。关闭对话框即视为已妥善保存，令牌不再可查看。 */
  token: string | null;
  connectionName: string;
  onClose: () => void;
};

/**
 * 连接令牌只显示一次：服务端只在创建 / 轮换时返回明文，
 * 关闭此对话框后前端立即丢弃，不再保存到任何状态或缓存。
 */
export function TokenDisplayDialog({ token, connectionName, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // 剪贴板不可用时用户仍可手动选择复制。
    }
  };

  return (
    <Dialog
      open={token !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>连接令牌（仅显示一次）</DialogTitle>
          <DialogDescription>
            「{connectionName}」的连接令牌已生成。请立即复制并妥善保存，
            关闭此窗口后将无法再次查看，只能通过轮换生成新令牌。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-xs break-all select-all">
            {token}
          </code>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="复制令牌"
            onClick={copy}
          >
            {copied ? <CheckIcon className="text-emerald-600" /> : <CopyIcon />}
          </Button>
        </div>

        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          令牌等同于该连接的完整访问权限，请勿提交到代码仓库或发送到公开渠道。
        </p>

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {copied ? "我已保存" : "关闭并丢弃显示"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

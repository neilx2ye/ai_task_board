"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  /** 要复制到剪贴板的完整文本。 */
  text: string;
  /** 无障碍标签，说明复制的是哪段内容。 */
  label: string;
};

/** 帮助页代码块的复制按钮；剪贴板不可用时静默失败，用户仍可手动选择复制。 */
export function CopyButton({ text, label }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用时用户仍可手动选择复制。
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground"
      aria-label={copied ? `${label}已复制` : label}
      onClick={copy}
    >
      {copied ? <CheckIcon className="text-emerald-600" /> : <CopyIcon />}
    </Button>
  );
}

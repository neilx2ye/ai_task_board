"use client";

import { useRef, useState } from "react";
import { PaperclipIcon, UploadIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUploadArtifact } from "@/hooks/use-tasks";
import { formatBytes } from "@/components/utils";

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

/** 任务附件上传控件：选择文件 → 校验大小 → multipart 上传。 */
export function ArtifactUpload({ taskId }: { taskId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadArtifact = useUploadArtifact(taskId);

  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setFile(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onSelect = (selected: File | null) => {
    setError(null);
    if (!selected) {
      setFile(null);
      return;
    }
    if (selected.size > MAX_ARTIFACT_BYTES) {
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setError(
        `文件 ${formatBytes(selected.size)} 超过 50 MiB 上限，请选择更小的文件`,
      );
      return;
    }
    setFile(selected);
  };

  const onUpload = async () => {
    if (!file) return;
    setError(null);
    try {
      await uploadArtifact.mutateAsync(file);
      clear();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败，请稍后重试");
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={`artifact-file-${taskId}`}
          type="file"
          className="sr-only"
          aria-describedby={`artifact-hint-${taskId}`}
          onChange={(event) => onSelect(event.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploadArtifact.isPending}
          onClick={() => inputRef.current?.click()}
        >
          <PaperclipIcon />
          选择文件
        </Button>
        <span
          id={`artifact-hint-${taskId}`}
          className="text-xs text-muted-foreground"
        >
          单个文件最大 50 MiB
        </span>
      </div>

      {file ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {file.name}
            <span className="ml-1 text-xs text-muted-foreground">
              （{formatBytes(file.size)}）
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            disabled={uploadArtifact.isPending}
            onClick={onUpload}
          >
            <UploadIcon />
            {uploadArtifact.isPending ? "上传中…" : "上传"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="移除所选文件"
            disabled={uploadArtifact.isPending}
            onClick={clear}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { FileWarningIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { formatBytes, formatDateTime } from "@/components/utils";
import {
  useDeviceFileExplorerFile,
  useFileExplorerFile,
} from "@/hooks/use-file-explorer";
import { isMarkdownFile } from "@/lib/file-kinds";
import type { FilePreview, FileSource } from "@/lib/types/domain";

function PreviewMeta({ preview }: { preview: FilePreview }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {preview.name}
      </span>
      {preview.kind === "text" && preview.truncated ? (
        <Badge variant="secondary">仅显示前 1 MB</Badge>
      ) : null}
      {preview.size !== null ? (
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatBytes(preview.size)}
        </span>
      ) : null}
      {preview.modifiedAt ? (
        <span className="text-xs text-muted-foreground">
          更新于 {formatDateTime(preview.modifiedAt)}
        </span>
      ) : null}
    </div>
  );
}

function TextPreview({ preview }: { preview: FilePreview & { kind: "text" } }) {
  if (isMarkdownFile(preview.name)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <article className="markdown-preview">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {preview.content}
          </ReactMarkdown>
        </article>
      </div>
    );
  }

  return (
    <pre className="min-h-0 flex-1 overflow-auto px-5 py-4 font-mono text-xs leading-relaxed text-foreground">
      {preview.content}
    </pre>
  );
}

function ImagePreview({ preview }: { preview: FilePreview & { kind: "image" } }) {
  return (
    <div className="checkerboard min-h-0 flex-1 overflow-auto p-6">
      {/* 数据 URL 不经过 next/image 优化，直接渲染以支持任意尺寸图片。 */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={preview.dataUrl}
        alt={preview.name}
        className="mx-auto max-h-full max-w-full rounded-md border border-border object-contain shadow-sm"
      />
    </div>
  );
}

export function FilePreview({
  path,
  source = { kind: "local" },
}: {
  path: string | null;
  source?: FileSource;
}) {
  const localPreview = useFileExplorerFile(
    source.kind === "local" ? path : null,
  );
  const devicePreview = useDeviceFileExplorerFile(
    source.kind === "device" ? source.connectionId : null,
    source.kind === "device" ? path : null,
  );
  const preview = source.kind === "device" ? devicePreview : localPreview;

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<FileWarningIcon className="size-6" />}
          title="还没有选中文件"
          description="在左侧文件树中点击一个文件，即可在这里预览 Markdown、图片或文本内容。"
          className="w-full max-w-md"
        />
      </div>
    );
  }

  const showingPreviousFile =
    preview.isFetching && preview.data?.path !== path;
  if (preview.isLoading || showingPreviousFile) {
    return (
      <div className="p-4 lg:p-6">
        <LoadingBlock label="加载文件预览…" />
      </div>
    );
  }

  if (preview.error || !preview.data) {
    return (
      <div className="p-4 lg:p-6">
        <ErrorState
          message={preview.error?.message ?? "没有可预览的内容"}
          onRetry={() => void preview.refetch()}
        />
      </div>
    );
  }

  const data = preview.data;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <PreviewMeta preview={data} />
      </header>

      {data.kind === "text" ? (
        <TextPreview preview={data} />
      ) : data.kind === "image" ? (
        <ImagePreview preview={data} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
          <EmptyState
            icon={<FileWarningIcon className="size-6" />}
            title="无法预览此文件"
            description={`${data.reason}（${data.name}${data.size !== null ? `，${formatBytes(data.size)}` : ""}）`}
            className="w-full max-w-md"
          />
        </div>
      )}
    </div>
  );
}

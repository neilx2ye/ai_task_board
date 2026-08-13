"use client";

import { useParams } from "next/navigation";
import Link from "next/link";

import { ErrorState, LoadingBlock } from "@/components/states";
import { TaskDetailView } from "@/components/task-detail-view";
import { Button } from "@/components/ui/button";
import { useTaskDetails } from "@/hooks/use-tasks";
import { ApiError } from "@/hooks/api-client";

export default function TaskDetailPage() {
  const params = useParams<{ taskId: string }>();
  const taskId = params.taskId;
  const detailsQuery = useTaskDetails(taskId);

  if (detailsQuery.isLoading) {
    return <LoadingBlock label="加载任务详情…" />;
  }

  if (detailsQuery.error || !detailsQuery.data) {
    const error = detailsQuery.error;
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        <ErrorState
          title={notFound ? "任务不存在" : "加载任务详情失败"}
          message={
            notFound
              ? "该任务可能已被移除，或不属于当前工作区。"
              : (error?.message ?? "未知错误")
          }
          onRetry={notFound ? undefined : () => void detailsQuery.refetch()}
        />
        <Button variant="outline" className="w-fit" asChild>
          <Link href="/sessions">返回会话与上下文</Link>
        </Button>
      </div>
    );
  }

  return <TaskDetailView details={detailsQuery.data} />;
}

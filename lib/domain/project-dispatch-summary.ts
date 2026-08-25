import type {
  ProjectDeletionResponse,
  ProjectDispatchResult,
} from "@/lib/types/database";

/** 把项目更新的 Bridge 分发结果汇总成给用户的提示文案。 */
export function summarizeProjectUpdateResults(
  results: ProjectDispatchResult[],
): string {
  const submitted = results.filter((result) => result.status === "submitted");
  const skipped = results.filter((result) => result.status === "skipped");
  const failed = results.filter((result) => result.status === "failed");
  const parts = [
    submitted.length > 0
      ? `已更新 ${submitted.length} 个 Bridge：${submitted
          .map((result) => result.connection_name)
          .join("、")}。`
      : "没有 Bridge 接受这次修改。",
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
  parts.push("Bridge 应用并同步后，新名称与路径会生效。");
  return parts.join("");
}

/** 把项目删除的数据库清理与 Bridge 分发结果汇总成用户提示文案。 */
export function summarizeProjectDeleteResults(
  response: ProjectDeletionResponse,
): string {
  const submitted = response.results.filter(
    (result) => result.status === "submitted",
  );
  const skipped = response.results.filter(
    (result) => result.status === "skipped",
  );
  const failed = response.results.filter(
    (result) => result.status === "failed",
  );

  const parts: string[] = [];
  if (response.deleted_directory_rows > 0) {
    parts.push(
      `已从数据库删除 ${response.deleted_directory_rows} 条项目记录。`,
    );
  }
  if (submitted.length > 0) {
    parts.push(
      `已通知 ${submitted.length} 个 Bridge 停止托管该目录：${submitted
        .map((result) => result.connection_name)
        .join("、")}。`,
    );
  }
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
  if (
    response.deleted_directory_rows === 0 &&
    submitted.length === 0 &&
    skipped.length === 0 &&
    failed.length === 0
  ) {
    parts.push("没有找到该项目的数据库记录。");
  }
  parts.push("本机上的项目文件不会被删除。");
  return parts.join("");
}

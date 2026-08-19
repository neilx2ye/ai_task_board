import { describe, expect, it } from "vitest";

import { summarizeProjectUpdateResults } from "@/lib/domain/project-dispatch-summary";
import type { ProjectDispatchResult } from "@/lib/types/database";

describe("summarizeProjectUpdateResults", () => {
  it("reports submitted, skipped and failed bridges", () => {
    const results: ProjectDispatchResult[] = [
      {
        connection_id: "c1",
        connection_name: "开发笔记本",
        status: "submitted",
      },
      {
        connection_id: "c2",
        connection_name: "工作台式机",
        status: "skipped",
        reason: "该项目不在该 Bridge 的目录清单中",
      },
      {
        connection_id: "c3",
        connection_name: "服务器",
        status: "failed",
        reason: "配置版本冲突，请重试",
      },
    ];

    expect(summarizeProjectUpdateResults(results)).toBe(
      "已更新 1 个 Bridge：开发笔记本。跳过 1 个：工作台式机（该项目不在该 Bridge 的目录清单中）。失败 1 个：服务器（配置版本冲突，请重试）。Bridge 应用并同步后，新名称与路径会生效。",
    );
  });

  it("explains when no bridge accepted the update", () => {
    const results: ProjectDispatchResult[] = [
      {
        connection_id: "c1",
        connection_name: "开发笔记本",
        status: "skipped",
        reason: "目标路径已在目录清单中",
      },
    ];

    expect(summarizeProjectUpdateResults(results)).toBe(
      "没有 Bridge 接受这次修改。跳过 1 个：开发笔记本（目标路径已在目录清单中）。Bridge 应用并同步后，新名称与路径会生效。",
    );
  });
});

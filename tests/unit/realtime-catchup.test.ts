import { describe, expect, it, vi } from "vitest";

import { catchUpEventCursor } from "@/hooks/realtime-catchup";

describe("catchUpEventCursor", () => {
  it("单页不满即追平，推进游标并统计遗漏", async () => {
    const fetchPage = vi.fn(async () => [6, 7, 8]);
    const onAdvance = vi.fn();

    const result = await catchUpEventCursor({
      cursor: 5,
      fetchPage,
      pageSize: 200,
      onAdvance,
    });

    expect(result).toEqual({ cursor: 8, missed: 3 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(5, 200);
    expect(onAdvance.mock.calls.map(([id]) => id)).toEqual([6, 7, 8]);
  });

  it("多页分页直到出现不满一页", async () => {
    const pages = new Map<number, number[]>([
      [5, [6, 7]],
      [7, [8, 9]],
      [9, [10]],
    ]);
    const fetchPage = vi.fn(async (afterId: number) => pages.get(afterId) ?? []);

    const result = await catchUpEventCursor({
      cursor: 5,
      fetchPage,
      pageSize: 2,
    });

    expect(result).toEqual({ cursor: 10, missed: 5 });
    expect(fetchPage.mock.calls.map(([afterId]) => afterId)).toEqual([5, 7, 9]);
  });

  it("没有遗漏事件时游标不变", async () => {
    const fetchPage = vi.fn(async () => []);

    const result = await catchUpEventCursor({ cursor: 42, fetchPage });

    expect(result).toEqual({ cursor: 42, missed: 0 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("乱序与重复行只按更大值单调推进", async () => {
    const fetchPage = vi.fn(async () => [12, 11, 12, 9]);

    const result = await catchUpEventCursor({
      cursor: 10,
      fetchPage,
      pageSize: 200,
    });

    expect(result.cursor).toBe(12);
    expect(result.missed).toBe(4);
  });

  it("整页不产生新游标时按推进断言退出，避免死循环", async () => {
    // 数据源异常：无论 afterId 是多少都返回同一页旧数据。
    const fetchPage = vi.fn(async () => [6, 7]);

    const result = await catchUpEventCursor({
      cursor: 5,
      fetchPage,
      pageSize: 2,
    });

    // 第一轮推进到 7；第二轮 fetchPage(7) 仍返回 [6,7]，无法推进 → 退出。
    expect(result.cursor).toBe(7);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

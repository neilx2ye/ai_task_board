/**
 * Realtime 断线后基于 TaskEvent id 游标的补拉逻辑。
 * 纯函数便于单测；Supabase 查询由调用方以 fetchPage 注入。
 */

export const EVENTS_PAGE_SIZE = 200;

export type CatchUpResult = {
  /** 补拉结束后的游标（单调不减）。 */
  cursor: number;
  /** 补拉期间发现的遗漏事件条数。 */
  missed: number;
};

/**
 * 从 cursor 之后分页补拉事件 id，直到追平。
 * - fetchPage 返回 id > afterId 的升序事件 id 列表（最多 pageSize 条）。
 * - 游标只按更大值单调推进，容忍乱序 / 重复行（与实时回调竞态安全）。
 * - 每页断言游标严格推进，数据源异常时退出而非死循环。
 */
export async function catchUpEventCursor(options: {
  cursor: number;
  fetchPage: (afterId: number, limit: number) => Promise<readonly number[]>;
  pageSize?: number;
  onAdvance?: (id: number) => void;
}): Promise<CatchUpResult> {
  const { fetchPage, onAdvance } = options;
  const pageSize = options.pageSize ?? EVENTS_PAGE_SIZE;
  let cursor = options.cursor;
  let missed = 0;

  for (;;) {
    const before = cursor;
    const ids = await fetchPage(before, pageSize);
    if (ids.length === 0) break;

    for (const id of ids) {
      if (id > cursor) {
        cursor = id;
        onAdvance?.(id);
      }
    }
    missed += ids.length;

    // 推进断言：整页没有产生任何新游标，说明数据异常，立即退出。
    if (cursor === before) break;
    // 不满一页说明已经追到最新。
    if (ids.length < pageSize) break;
  }

  return { cursor, missed };
}

export const POSTGREST_PAGE_SIZE = 500;
export const POSTGREST_IN_FILTER_BATCH_SIZE = 100;

export function chunkValues<T>(
  values: readonly T[],
  size = POSTGREST_IN_FILTER_BATCH_SIZE,
): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error("Chunk size must be a positive safe integer");
  }
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Read a stable PostgREST ordering through explicit Range pages. Keeping each
 * request below Hosted Supabase's usual max_rows avoids silent truncation.
 */
export async function collectRangePages<T>(
  fetchPage: (from: number, to: number) => Promise<readonly T[]>,
  options: { maxRows?: number; pageSize?: number } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? POSTGREST_PAGE_SIZE;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("Page size must be a positive safe integer");
  }
  if (
    maxRows !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxRows) || maxRows < 0)
  ) {
    throw new Error("Maximum rows must be a non-negative safe integer");
  }

  const rows: T[] = [];
  while (rows.length < maxRows) {
    const requested = Math.min(pageSize, maxRows - rows.length);
    const page = await fetchPage(rows.length, rows.length + requested - 1);
    rows.push(...page);
    if (page.length < requested) break;
  }
  return rows;
}

export async function collectChunkedRows<TValue, TRow>(
  values: readonly TValue[],
  fetchChunk: (values: readonly TValue[]) => Promise<readonly TRow[]>,
  chunkSize = POSTGREST_IN_FILTER_BATCH_SIZE,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (const chunk of chunkValues(values, chunkSize)) {
    rows.push(...(await fetchChunk(chunk)));
  }
  return rows;
}

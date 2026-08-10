import { describe, expect, it, vi } from "vitest";

import {
  chunkValues,
  collectChunkedRows,
  collectRangePages,
} from "@/lib/domain/postgrest-pagination";

describe("PostgREST pagination helpers", () => {
  it("uses explicit ranges until the complete result is loaded", async () => {
    const source = Array.from({ length: 1_200 }, (_, index) => index);
    const fetchPage = vi.fn(async (from: number, to: number) =>
      source.slice(from, to + 1),
    );

    const rows = await collectRangePages(fetchPage);

    expect(rows).toEqual(source);
    expect(fetchPage.mock.calls).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
  });

  it("loads an exact limit plus sentinel across Hosted-sized pages", async () => {
    const source = Array.from({ length: 8_000 }, (_, index) => index);
    const fetchPage = vi.fn(async (from: number, to: number) =>
      source.slice(from, to + 1),
    );

    const rows = await collectRangePages(fetchPage, { maxRows: 5_001 });

    expect(rows).toHaveLength(5_001);
    expect(rows.at(-1)).toBe(5_000);
    expect(fetchPage.mock.calls.at(-1)).toEqual([5_000, 5_000]);
  });

  it("batches large in-filter inputs without losing rows", async () => {
    const values = Array.from({ length: 205 }, (_, index) => `id-${index}`);
    const fetchChunk = vi.fn(async (chunk: readonly string[]) => chunk);

    expect(chunkValues(values).map((chunk) => chunk.length)).toEqual([100, 100, 5]);
    expect(await collectChunkedRows(values, fetchChunk)).toEqual(values);
    expect(fetchChunk).toHaveBeenCalledTimes(3);
  });
});

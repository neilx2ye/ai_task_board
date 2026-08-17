import { describe, expect, it } from "vitest";

import {
  CONNECTION_COLOR_COUNT,
  connectionColorMeta,
} from "@/components/connection-meta";

describe("connectionColorMeta", () => {
  it("同一连接 id 稳定映射到同一组颜色", () => {
    const first = connectionColorMeta("conn-abc");
    expect(connectionColorMeta("conn-abc")).toEqual(first);
  });

  it("不同连接 id 可能落在不同颜色上", () => {
    expect(connectionColorMeta("conn-abc")).not.toEqual(
      connectionColorMeta("conn-xyz"),
    );
  });

  it("缺失 id 时回退到确定性的默认颜色", () => {
    expect(connectionColorMeta(null)).toEqual(connectionColorMeta(undefined));
    expect(connectionColorMeta(null)).toEqual(connectionColorMeta(""));
  });

  it("调色板每组都提供圆点、徽标与标识条样式，且样本不会退化为单色", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 256; index += 1) {
      const meta = connectionColorMeta(`connection-${index}`);
      expect(meta.dotClass).toMatch(/^bg-/);
      expect(meta.badgeClass).toMatch(/^border-/);
      expect(meta.barClass).toMatch(/^bg-/);
      seen.add(meta.barClass);
    }
    expect(CONNECTION_COLOR_COUNT).toBeGreaterThan(1);
    expect(seen.size).toBeGreaterThan(1);
  });
});

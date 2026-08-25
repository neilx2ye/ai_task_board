import { describe, expect, it } from "vitest";

import {
  CONNECTION_COLOR_COUNT,
  connectionColorMeta,
  connectionRuntimeColorMeta,
  runtimeColorMeta,
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

describe("connectionRuntimeColorMeta", () => {
  it("统一设备连接按运行时固定取色，四种 CLI 互不相同", () => {
    const colors = ["codex", "kimi", "antigravity", "claude"].map((kind) =>
      connectionRuntimeColorMeta("unified-1", "All", kind),
    );

    expect(new Set(colors.map((color) => color.barClass)).size).toBe(4);
    // 同一运行时在不同连接上颜色也保持稳定。
    expect(
      connectionRuntimeColorMeta("unified-2", "All", "kimi"),
    ).toEqual(connectionRuntimeColorMeta("unified-1", "All", "kimi"));
  });

  it("未知运行时回退到连接 id 的稳定散列色", () => {
    expect(
      connectionRuntimeColorMeta("unified-1", "All", "gemini"),
    ).toEqual(connectionColorMeta("unified-1"));
  });

  it("非统一连接忽略运行时参数，保持原有连接散列色", () => {
    expect(
      connectionRuntimeColorMeta("conn-abc", "Codex", "kimi"),
    ).toEqual(connectionColorMeta("conn-abc"));
  });

  it("runtimeColorMeta 对未知类型返回 null", () => {
    expect(runtimeColorMeta("gemini")).toBeNull();
    expect(runtimeColorMeta(null)).toBeNull();
    expect(runtimeColorMeta("kimi")?.barClass).toBe(
      runtimeColorMeta("Kimi Code")?.barClass,
    );
  });
});

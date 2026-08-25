import { describe, expect, it } from "vitest";

import {
  compareBridgeVersions,
  isBridgeVersionString,
} from "@/lib/bridge-version";

describe("compareBridgeVersions", () => {
  it.each([
    ["1.4.0", "1.3.0", 1],
    ["1.3.0", "1.4.0", -1],
    ["1.4.0", "1.4.0", 0],
    ["2.0.0", "1.9.9", 1],
    ["1.4.1", "1.4.0", 1],
    ["0.9.0", "0.10.0", -1],
    ["v1.4.0", "1.4.0", 0],
  ])("compare(%s, %s) === %i", (left, right, expected) => {
    expect(compareBridgeVersions(left, right)).toBe(expected);
  });

  it("运行时后缀与发布版同基时视为相等", () => {
    expect(compareBridgeVersions("1.4.0-kimi.1", "1.4.0")).toBe(0);
    expect(compareBridgeVersions("1.4.0-antigravity.1", "1.4.0")).toBe(0);
    expect(compareBridgeVersions("1.4.1-kimi.1", "1.4.0")).toBe(1);
  });

  it.each([
    [null, "1.4.0"],
    ["1.4.0", undefined],
    ["dev", "1.4.0"],
    ["1.4.0", "not-a-version"],
  ])("无法解析时返回 null（%s vs %s）", (left, right) => {
    expect(compareBridgeVersions(left, right)).toBeNull();
  });
});

describe("isBridgeVersionString", () => {
  it.each(["1.4.0", "v1.4.0", "0.0.1", "1.4.0-kimi.1", " 1.4.0 "])(
    "接受 %j",
    (value) => {
      expect(isBridgeVersionString(value)).toBe(true);
    },
  );

  it.each(["", "1.4", "1.4.0.0", "latest", "1.x.0", "../1.4.0", "1.4.0; rm"])(
    "拒绝 %j",
    (value) => {
      expect(isBridgeVersionString(value)).toBe(false);
    },
  );
});

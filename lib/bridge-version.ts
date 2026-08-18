/**
 * Bridge 版本比较：提取前导 major.minor.patch 数字段比较；
 * 运行时后缀（如 1.6.0-kimi.1）与发布版同基时视为相等。
 * 无法解析时返回 null。
 */
export function compareBridgeVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): number | null {
  const parse = (value: string | null | undefined) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value?.trim() ?? "");
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/** 严格的 x.y.z 校验（允许 v 前缀与 -suffix 预发布/运行时后缀）。 */
export function isBridgeVersionString(value: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.trim());
}

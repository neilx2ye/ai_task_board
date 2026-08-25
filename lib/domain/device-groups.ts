import type { PublicConnection } from "@/hooks/use-connections";

export type ConnectionDeviceGroup = {
  /** 上报了 device_id 的设备用该 id；否则退化为单 Bridge 设备（connection id）。 */
  deviceId: string;
  /** 展示名：组内首个非空 device_label，否则首个连接名。 */
  label: string;
  /** 设备标识为 Bridge 自上报时才为 true。 */
  reported: boolean;
  connections: PublicConnection[];
};

function compareDeviceGroups(
  left: ConnectionDeviceGroup,
  right: ConnectionDeviceGroup,
): number {
  return (
    left.label.localeCompare(right.label, "zh-CN") ||
    left.deviceId.localeCompare(right.deviceId)
  );
}

/**
 * 把连接按设备分组：Bridge 1.3.0 起在会话同步里上报稳定的 device_id 与
 * hostname 标签；未上报的旧 Bridge 各自构成单 Bridge 设备。
 */
export function groupConnectionsByDevice(
  connections: readonly PublicConnection[],
): ConnectionDeviceGroup[] {
  const byDevice = new Map<string, PublicConnection[]>();
  for (const connection of connections) {
    const key = connection.device_id ?? `connection:${connection.id}`;
    const group = byDevice.get(key);
    if (group) group.push(connection);
    else byDevice.set(key, [connection]);
  }

  return [...byDevice.entries()]
    .map(([deviceId, group]) => ({
      deviceId,
      reported: group[0]?.device_id != null,
      label:
        group.find((connection) => connection.device_label)?.device_label ??
        group[0]?.name ??
        deviceId,
      connections: group,
    }))
    .sort(compareDeviceGroups);
}

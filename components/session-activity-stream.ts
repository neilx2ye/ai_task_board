import type { Json } from "@/lib/types/database";
import type { SessionActivityItem } from "@/lib/types/domain";

const APP_SERVER_ACTIVITY_PROTOCOL = "codex-app-server/v1";

type AppServerActivityPhase = "started" | "delta" | "completed";

type AppServerActivityDescriptor = {
  key: string;
  phase: AppServerActivityPhase;
  chunkIndex: number | null;
};

type AppServerActivityGroup = {
  started: SessionActivityItem | null;
  deltas: Map<number, SessionActivityItem>;
  completed: SessionActivityItem | null;
};

function isJsonObject(
  value: SessionActivityItem["data"],
): value is { [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function describeAppServerActivity(
  activity: SessionActivityItem,
): AppServerActivityDescriptor | null {
  if (!isJsonObject(activity.data)) return null;

  const { protocol, phase, turn_ref: turnRef, item_ref: itemRef } = activity.data;
  if (
    protocol !== APP_SERVER_ACTIVITY_PROTOCOL ||
    (phase !== "started" && phase !== "delta" && phase !== "completed") ||
    !nonEmptyString(turnRef) ||
    !nonEmptyString(itemRef)
  ) {
    return null;
  }

  if (
    phase === "delta" &&
    (!Number.isSafeInteger(activity.data.chunk_index) ||
      (activity.data.chunk_index as number) < 0)
  ) {
    return null;
  }

  return {
    key: JSON.stringify([activity.session_id, turnRef, itemRef]),
    phase,
    chunkIndex:
      phase === "delta" ? (activity.data.chunk_index as number) : null,
  };
}

function compareActivityOrder(
  left: SessionActivityItem,
  right: SessionActivityItem,
): number {
  const byTime = left.created_at.localeCompare(right.created_at);
  if (byTime) return byTime;

  try {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  } catch {
    return left.id.localeCompare(right.id);
  }
}

function laterActivity(
  current: SessionActivityItem | null,
  candidate: SessionActivityItem,
): SessionActivityItem {
  return !current || compareActivityOrder(current, candidate) <= 0
    ? candidate
    : current;
}

function materializeGroup(group: AppServerActivityGroup): SessionActivityItem {
  if (group.completed) return group.completed;

  const deltas = [...group.deltas.entries()].sort(
    ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
  );
  if (deltas.length > 0) {
    const base = deltas[0][1];
    const chunks = deltas
      .map(([, activity]) => activity.content)
      .filter((content): content is string => content !== null);

    return {
      ...base,
      content: chunks.length > 0 ? chunks.join("") : null,
    };
  }

  // Every valid group has at least one activity. With neither completion nor
  // deltas present, it can only contain a started phase.
  return group.started as SessionActivityItem;
}

/**
 * Collapses the append-only Codex App Server stream into one visible activity
 * per logical item. Completed items are authoritative; in-flight delta chunks
 * are ordered and de-duplicated by chunk_index. Non-protocol activities pass
 * through untouched for backwards compatibility.
 */
export function reduceAppServerActivityStream(
  activities: readonly SessionActivityItem[],
): SessionActivityItem[] {
  const descriptors = new Map<SessionActivityItem, AppServerActivityDescriptor>();
  const groups = new Map<string, AppServerActivityGroup>();

  for (const activity of activities) {
    const descriptor = describeAppServerActivity(activity);
    if (!descriptor) continue;

    descriptors.set(activity, descriptor);
    const group = groups.get(descriptor.key) ?? {
      started: null,
      deltas: new Map<number, SessionActivityItem>(),
      completed: null,
    };

    if (descriptor.phase === "started") {
      group.started = laterActivity(group.started, activity);
    } else if (descriptor.phase === "completed") {
      group.completed = laterActivity(group.completed, activity);
    } else {
      const chunkIndex = descriptor.chunkIndex as number;
      group.deltas.set(
        chunkIndex,
        laterActivity(group.deltas.get(chunkIndex) ?? null, activity),
      );
    }
    groups.set(descriptor.key, group);
  }

  const emittedGroups = new Set<string>();
  const reduced: SessionActivityItem[] = [];
  for (const activity of activities) {
    const descriptor = descriptors.get(activity);
    if (!descriptor) {
      reduced.push(activity);
      continue;
    }
    if (emittedGroups.has(descriptor.key)) continue;

    reduced.push(materializeGroup(groups.get(descriptor.key) as AppServerActivityGroup));
    emittedGroups.add(descriptor.key);
  }

  return reduced;
}

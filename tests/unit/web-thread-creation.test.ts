import { describe, expect, it } from "vitest";

import {
  findCreatedWebThread,
  type PendingWebThreadCreation,
} from "@/lib/domain/web-thread-creation";
import type { SessionListItem } from "@/lib/types/domain";

function session(input: {
  id: string;
  connectionId?: string;
  directoryKey?: string | null;
  name?: string;
}): SessionListItem {
  return {
    id: input.id,
    connection_id: input.connectionId ?? "connection-1",
    bridge_directory_key:
      input.directoryKey === undefined ? "app" : input.directoryKey,
    name: input.name ?? "新 Thread",
  } as SessionListItem;
}

const pending: PendingWebThreadCreation = {
  connectionId: "connection-1",
  directoryKey: "app",
  name: "新 Thread",
  existingSessionIds: ["existing-thread"],
};

describe("Web Thread creation reconciliation", () => {
  it("finds the newly inventoried Thread for the submitted device and project", () => {
    const created = session({ id: "created-thread" });

    expect(
      findCreatedWebThread(
        [
          session({ id: "existing-thread" }),
          session({ id: "other-device", connectionId: "connection-2" }),
          session({ id: "other-project", directoryKey: "docs" }),
          created,
        ],
        pending,
      ),
    ).toBe(created);
  });

  it("does not mistake an existing same-name Thread for the new one", () => {
    expect(
      findCreatedWebThread([session({ id: "existing-thread" })], pending),
    ).toBeNull();
  });

  it("supports legacy Bridges that create without a directory key", () => {
    const created = session({
      id: "created-thread",
      directoryKey: null,
    });

    expect(
      findCreatedWebThread(
        [created],
        { ...pending, directoryKey: null, existingSessionIds: [] },
      ),
    ).toBe(created);
  });
});

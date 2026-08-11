import { describe, expect, it } from "vitest";

import { groupSessionsByConnection } from "@/lib/domain/session-directory-groups";
import type { AIBridgeDirectoryRow } from "@/lib/types/database";
import type {
  SessionConnectionSummary,
  SessionListItem,
} from "@/lib/types/domain";

const connection: SessionConnectionSummary = {
  id: "connection-1",
  name: "Laptop",
  platform: "Codex",
  last_seen_at: null,
  bridge_version: "0.7.0",
  revoked_at: null,
};

function session(
  id: string,
  workingDirectory: string | null,
  directoryKey: string | null,
): SessionListItem {
  return {
    id,
    connection_id: connection.id,
    connection,
    working_directory: workingDirectory,
    bridge_directory_key: directoryKey,
    inventory_active: true,
  } as SessionListItem;
}

function directory(
  key: string,
  name: string,
  workingDirectory: string,
): AIBridgeDirectoryRow {
  return {
    connection_id: connection.id,
    directory_key: key,
    name,
    working_directory: workingDirectory,
    inventory_active: true,
  } as AIBridgeDirectoryRow;
}

describe("Session working-directory hierarchy", () => {
  it("keeps configured empty directories and assigns Sessions by stable key", () => {
    const [group] = groupSessionsByConnection(
      [session("thread-a", "/workspace/main", "main")],
      [connection],
      [
        directory("main", "Main app", "/workspace/main"),
        directory("docs", "Docs", "/workspace/docs"),
      ],
    );

    expect(group.directories).toEqual([
      expect.objectContaining({
        directoryKey: "docs",
        name: "Docs",
        sessions: [],
      }),
      expect.objectContaining({
        directoryKey: "main",
        name: "Main app",
        sessions: [expect.objectContaining({ id: "thread-a" })],
      }),
    ]);
  });

  it("groups legacy and all-scope Sessions by their reported cwd", () => {
    const [group] = groupSessionsByConnection(
      [
        session("thread-a", "/workspace/legacy", null),
        session("thread-b", "/workspace/legacy", null),
        session("thread-c", null, null),
      ],
      [connection],
    );

    expect(group.directories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "legacy",
          configured: false,
          sessions: [
            expect.objectContaining({ id: "thread-a" }),
            expect.objectContaining({ id: "thread-b" }),
          ],
        }),
        expect.objectContaining({ name: "未归类" }),
      ]),
    );
  });
});

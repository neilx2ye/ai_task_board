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
  sessionConnection: SessionConnectionSummary = connection,
): SessionListItem {
  return {
    id,
    connection_id: sessionConnection.id,
    connection: sessionConnection,
    working_directory: workingDirectory,
    bridge_directory_key: directoryKey,
    inventory_active: true,
  } as SessionListItem;
}

function directory(
  key: string,
  name: string,
  workingDirectory: string,
  connectionId = connection.id,
): AIBridgeDirectoryRow {
  return {
    connection_id: connectionId,
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

  it("omits removed directories and inactive Sessions", () => {
    const inactiveSession = session("thread-stale", "/workspace/main", "main");
    inactiveSession.inventory_active = false;
    const removedDirectory = directory("docs", "Docs", "/workspace/docs");
    removedDirectory.inventory_active = false;

    const [group] = groupSessionsByConnection(
      [
        session("thread-current", "/workspace/main", "main"),
        inactiveSession,
        // The directory inventory is authoritative even if a stale Session
        // snapshot still says it is active.
        session("thread-removed", "/workspace/docs", "docs"),
      ],
      [connection],
      [directory("main", "Main app", "/workspace/main"), removedDirectory],
    );

    expect(group.directories).toEqual([
      expect.objectContaining({
        directoryKey: "main",
        sessions: [expect.objectContaining({ id: "thread-current" })],
      }),
    ]);
    expect(group.sessions.map((item) => item.id)).toEqual(["thread-current"]);
  });

  it("isolates matching directory keys between connections", () => {
    const secondConnection: SessionConnectionSummary = {
      ...connection,
      id: "connection-2",
      name: "Desktop",
    };

    const groups = groupSessionsByConnection(
      [
        session("thread-a", "/workspace/laptop", "main"),
        session(
          "thread-b",
          "/workspace/desktop",
          "main",
          secondConnection,
        ),
      ],
      [connection, secondConnection],
      [
        directory("main", "Laptop app", "/workspace/laptop"),
        directory(
          "main",
          "Desktop app",
          "/workspace/desktop",
          secondConnection.id,
        ),
      ],
    );

    expect(groups).toEqual([
      expect.objectContaining({
        connection,
        directories: [
          expect.objectContaining({
            name: "Laptop app",
            sessions: [expect.objectContaining({ id: "thread-a" })],
          }),
        ],
      }),
      expect.objectContaining({
        connection: secondConnection,
        directories: [
          expect.objectContaining({
            name: "Desktop app",
            sessions: [expect.objectContaining({ id: "thread-b" })],
          }),
        ],
      }),
    ]);
  });
});

import { describe, expect, it } from "vitest";

import {
  excludeHiddenProjects,
  filterConnectionGroupsByProject,
  groupSessionsByConnection,
  listSessionProjects,
} from "@/lib/domain/session-directory-groups";
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

describe("Session project tabs", () => {
  const secondConnection: SessionConnectionSummary = {
    ...connection,
    id: "connection-2",
    name: "Desktop",
  };

  function twoConnectionGroups() {
    return groupSessionsByConnection(
      [
        session("thread-a", "/workspace/alpha", "alpha"),
        session("thread-b", "/workspace/alpha", "alpha", secondConnection),
        session("thread-c", "/workspace/beta", null, secondConnection),
        session("thread-d", null, null, secondConnection),
      ],
      [connection, secondConnection],
      [
        directory("alpha", "Alpha app", "/workspace/alpha"),
        directory("alpha", "Alpha app", "/workspace/alpha", secondConnection.id),
      ],
    );
  }

  it("merges the same working directory across connections into one project", () => {
    const projects = listSessionProjects(twoConnectionGroups());

    expect(projects).toEqual([
      expect.objectContaining({
        id: "path:/workspace/alpha",
        name: "Alpha app",
        workingDirectory: "/workspace/alpha",
        sessionCount: 2,
      }),
      expect.objectContaining({
        id: "path:/workspace/beta",
        name: "beta",
        sessionCount: 1,
      }),
      expect.objectContaining({
        id: "unassigned",
        name: "未归类",
        workingDirectory: null,
        sessionCount: 1,
      }),
    ]);
  });

  it("returns every group unchanged when no project is selected", () => {
    const groups = twoConnectionGroups();

    expect(filterConnectionGroupsByProject(groups, null)).toEqual(groups);
  });

  it("keeps only the selected project's directories per connection", () => {
    const filtered = filterConnectionGroupsByProject(
      twoConnectionGroups(),
      "path:/workspace/alpha",
    );

    expect(filtered).toHaveLength(2);
    for (const group of filtered) {
      expect(group.directories).toEqual([
        expect.objectContaining({ workingDirectory: "/workspace/alpha" }),
      ]);
      expect(
        group.sessions.map((item) => item.working_directory),
      ).toEqual(["/workspace/alpha"]);
    }
  });

  it("drops connections that do not serve the selected project", () => {
    const filtered = filterConnectionGroupsByProject(
      twoConnectionGroups(),
      "path:/workspace/beta",
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.connection.id).toBe(secondConnection.id);
    expect(filtered[0]?.sessions.map((item) => item.id)).toEqual(["thread-c"]);
  });

  it("excludes hidden projects and drops fully hidden connections", () => {
    const groups = twoConnectionGroups();

    expect(excludeHiddenProjects(groups, new Set())).toHaveLength(2);

    const filtered = excludeHiddenProjects(
      groups,
      new Set(["path:/workspace/alpha", "unassigned"]),
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.connection.id).toBe(secondConnection.id);
    expect(filtered[0]?.directories.map((item) => item.name)).toEqual(["beta"]);
    expect(filtered[0]?.sessions.map((item) => item.id)).toEqual(["thread-c"]);
  });
});

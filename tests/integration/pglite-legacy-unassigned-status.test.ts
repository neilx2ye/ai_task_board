import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  process.cwd(),
  "supabase/migrations/20260811160000_normalize_legacy_unassigned_tasks.sql",
);

describe("legacy unassigned task normalization", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;
    await database.exec(`
      create type public.task_status as enum (
        'inbox', 'ready', 'claimed', 'running', 'waiting_user',
        'blocked', 'completed', 'failed', 'cancelled', 'paused'
      );
      create type public.actor_type as enum ('user', 'ai', 'system');

      create table public.tasks (
        id uuid primary key,
        workspace_id uuid not null,
        parent_task_id uuid,
        status public.task_status not null,
        assigned_session_id uuid,
        claimed_by_session_id uuid
      );
      create table public.task_events (
        id bigint generated always as identity primary key,
        workspace_id uuid not null,
        task_id uuid not null,
        type text not null,
        actor_type public.actor_type not null,
        actor_id uuid,
        data jsonb not null default '{}'::jsonb
      );
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("moves only unassigned ready leaves to inbox and is idempotent", async () => {
    const workspaceId = randomUUID();
    const legacyLeafId = randomUUID();
    const assignedLeafId = randomUUID();
    const aggregateId = randomUUID();
    const aggregateChildId = randomUUID();
    const completedLeafId = randomUUID();

    await database.query(
      `insert into public.tasks (
         id, workspace_id, parent_task_id, status, assigned_session_id
       ) values
         ($1::uuid, $6::uuid, null, 'ready', null),
         ($2::uuid, $6::uuid, null, 'ready', $7::uuid),
         ($3::uuid, $6::uuid, null, 'ready', null),
         ($4::uuid, $6::uuid, $3::uuid, 'ready', $7::uuid),
         ($5::uuid, $6::uuid, null, 'completed', null)`,
      [
        legacyLeafId,
        assignedLeafId,
        aggregateId,
        aggregateChildId,
        completedLeafId,
        workspaceId,
        randomUUID(),
      ],
    );

    const migration = await readFile(migrationPath, "utf8");
    await database.exec(migration);
    await database.exec(migration);

    const states = await database.query<{ id: string; status: string }>(
      "select id, status::text from public.tasks order by id",
    );
    expect(new Map(states.rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [legacyLeafId, "inbox"],
        [assignedLeafId, "ready"],
        [aggregateId, "ready"],
        [aggregateChildId, "ready"],
        [completedLeafId, "completed"],
      ]),
    );

    const events = await database.query<{
      task_id: string;
      type: string;
      data: { from: string; to: string };
    }>("select task_id, type, data from public.task_events");
    expect(events.rows).toEqual([
      {
        task_id: legacyLeafId,
        type: "legacy_task_unbound",
        data: { from: "ready", to: "inbox" },
      },
    ]);
  });
});

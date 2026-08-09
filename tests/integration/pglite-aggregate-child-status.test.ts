import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type TaskState = {
  completed_at: string | null;
  id: string;
  status: string;
};

type TaskPayload = {
  id: string;
  status: string;
};

type CreateTaskResponse = {
  task: TaskPayload;
};

type CreateSubtasksResponse = {
  parent_task: TaskPayload;
  subtasks: TaskPayload[];
};

type WaitingFixture = {
  connectionId: string;
  messageId: string;
  sessionId: string;
};

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");

describe("aggregate child status migration regression", () => {
  let database: PGlite;
  let workspaceId: string;
  let assignmentSessionId: string;
  const userId = randomUUID();
  let idempotencyCounter = 0;

  const nextIdempotency = (operation: string) => {
    idempotencyCounter += 1;
    return {
      key: `pglite/${operation}/${idempotencyCounter}`,
      requestHash: `${operation}:${idempotencyCounter}`.padEnd(64, "0"),
    };
  };

  const createTask = async (parentTaskId: string | null, title: string) => {
    const idempotency = nextIdempotency("create-task");
    const result = await database.query<{ response: CreateTaskResponse }>(
      `select public.create_user_task(
         $1::uuid, $2::uuid, $3::uuid, $4::text,
         null, null, 0, null, $5::uuid, '{}'::text[], $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        userId,
        parentTaskId,
        title,
        assignmentSessionId,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return result.rows[0].response.task.id;
  };

  const setLeafStatus = async (
    aggregateTaskId: string,
    leafTaskId: string,
    status: "blocked" | "completed" | "waiting_user",
  ) => {
    await database.query(
      `update public.tasks
       set status = $2::public.task_status,
           completed_at = case when $2 = 'completed' then now() else null end
       where id = $1::uuid`,
      [leafTaskId, status],
    );
    await database.query("select public._recompute_parent($1::uuid)", [aggregateTaskId]);
    await database.query("select public._recompute_ancestors($1::uuid)", [
      aggregateTaskId,
    ]);
  };

  const createAggregateBranch = async (
    parentTaskId: string,
    title: string,
    status: "blocked" | "completed" | "waiting_user",
  ) => {
    const aggregateTaskId = await createTask(parentTaskId, title);
    const leafTaskId = await createTask(aggregateTaskId, `${title} leaf`);
    await setLeafStatus(aggregateTaskId, leafTaskId, status);
    return { aggregateTaskId, leafTaskId };
  };

  const taskState = async (taskId: string) => {
    const result = await database.query<TaskState>(
      `select id, status::text, completed_at::text
       from public.tasks
       where id = $1::uuid`,
      [taskId],
    );
    return result.rows[0];
  };

  const makeTaskWaitForUser = async (
    taskId: string,
    label: string,
  ): Promise<WaitingFixture> => {
    const connectionId = randomUUID();
    const sessionId = randomUUID();
    const messageId = randomUUID();
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, created_by_user_id
       ) values ($1::uuid, $2::uuid, $3::text, 'pglite', $4::text, $5::uuid)`,
      [connectionId, workspaceId, `${label} connection`, randomUUID().repeat(2), userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform, status
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::text, 'pglite', 'waiting'
       )`,
      [sessionId, workspaceId, connectionId, `${label} session`],
    );
    await database.query(
      `update public.tasks
       set status = 'waiting_user', assigned_session_id = $2::uuid,
           completed_at = null
       where id = $1::uuid`,
      [taskId, sessionId],
    );
    await database.query(
      `insert into public.task_messages (
         id, workspace_id, task_id, sender_type, sender_id, content,
         requires_response
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'ai', $4::uuid, $5::text, true
       )`,
      [messageId, workspaceId, taskId, sessionId, `${label} question`],
    );
    await database.query("select public._recompute_ancestors($1::uuid)", [taskId]);
    return { connectionId, messageId, sessionId };
  };

  const cancelTask = async (
    taskId: string,
    idempotency: { key: string; requestHash: string },
  ) => {
    const result = await database.query<{ response: { task: TaskPayload } }>(
      `select public.cancel_task(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        userId,
        taskId,
        "PGlite cancellation regression",
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return result.rows[0].response;
  };

  const messageReadAt = async (messageId: string) => {
    const result = await database.query<{ read_at: string | null }>(
      `select read_at::text
       from public.task_messages
       where id = $1::uuid`,
      [messageId],
    );
    return result.rows[0].read_at;
  };

  const sessionState = async (sessionId: string) => {
    const result = await database.query<{
      current_task_id: string | null;
      status: string;
    }>(
      `select current_task_id, status::text
       from public.ai_sessions
       where id = $1::uuid`,
      [sessionId],
    );
    return result.rows[0];
  };

  const cancellationEventCount = async (taskIds: string[]) => {
    const result = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.task_events
       where type = 'task_cancelled' and task_id = any($1::uuid[])`,
      [taskIds],
    );
    return result.rows[0].count;
  };

  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;

    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;

      create schema extensions;
      create function extensions.gen_random_uuid()
      returns uuid
      language sql
      volatile
      as $$ select pg_catalog.gen_random_uuid() $$;

      create schema auth;
      create table auth.users (
        id uuid primary key,
        email text,
        raw_user_meta_data jsonb not null default '{}'::jsonb
      );
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $$ select null::uuid $$;

      create schema storage;
      create table storage.buckets (
        id text primary key,
        name text not null,
        public boolean not null default false,
        file_size_limit bigint
      );
      create table storage.objects (
        id uuid primary key default pg_catalog.gen_random_uuid(),
        bucket_id text not null,
        name text not null
      );
    `);

    for (const migrationName of [
      "20260808000000_initial_schema.sql",
      "20260808000100_core_functions.sql",
      "20260808000200_rls_storage.sql",
      "20260808000300_session_directed_dispatch.sql",
    ]) {
      const migration = await readFile(
        path.join(migrationsDirectory, migrationName),
        "utf8",
      );
      // PGlite includes gen_random_uuid in pg_catalog but does not package the
      // Supabase pgcrypto extension control file. The shim above preserves the
      // Hosted function name used by the migrations.
      await database.exec(
        migration.replace(
          "create extension if not exists pgcrypto with schema extensions;",
          "",
        ),
      );
    }

    await database.query(
      "insert into auth.users (id, email) values ($1::uuid, $2::text)",
      [userId, `pglite-${userId}@example.invalid`],
    );
    const membership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [userId],
    );
    workspaceId = membership.rows[0].workspace_id;
    const assignmentConnectionId = randomUUID();
    assignmentSessionId = randomUUID();
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, created_by_user_id
       ) values ($1::uuid, $2::uuid, 'PGlite directed connection', 'pglite', $3::text, $4::uuid)`,
      [assignmentConnectionId, workspaceId, randomUUID().repeat(2), userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform, status, last_seen_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'PGlite directed session', 'pglite', 'online', now()
       )`,
      [assignmentSessionId, workspaceId, assignmentConnectionId],
    );
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("pulls only work reserved for the current session", async () => {
    const unassignedTaskId = randomUUID();
    const reservedTaskId = randomUUID();
    await database.query(
      `insert into public.tasks (
         id, workspace_id, root_task_id, title, status, priority,
         assigned_session_id, created_by_type
       ) values
         ($1::uuid, $3::uuid, $1::uuid, 'Legacy unassigned', 'ready', 1000, null, 'system'),
         ($2::uuid, $3::uuid, $2::uuid, 'Session reservation', 'ready', 10, $4::uuid, 'system')`,
      [unassignedTaskId, reservedTaskId, workspaceId, assignmentSessionId],
    );

    await expect(
      database.query(
        `select public._claim_task_internal(
           $1::uuid, $2::uuid, $3::uuid, $4::text, 900
         )`,
        [workspaceId, assignmentSessionId, unassignedTaskId, randomUUID().repeat(2)],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const claim = await database.query<{ task: TaskPayload }>(
      `select public._claim_next_internal(
         $1::uuid, $2::uuid, $3::text, 900, null
       ) as task`,
      [workspaceId, assignmentSessionId, randomUUID().repeat(2)],
    );
    expect(claim.rows[0].task).toMatchObject({
      id: reservedTaskId,
      status: "claimed",
    });
    expect((await taskState(unassignedTaskId)).status).toBe("ready");
  });

  it("preserves nested aggregates when bulk and single-child appends refresh siblings", async () => {
    // Bulk append path: P -> A -> A1 is blocked, while another aggregate is
    // completed. Appending a sibling must not derive A from A's own edge set.
    const bulkParentId = await createTask(null, "Bulk parent");
    const bulkBlocked = await createAggregateBranch(
      bulkParentId,
      "Bulk blocked aggregate",
      "blocked",
    );
    const bulkCompleted = await createAggregateBranch(
      bulkParentId,
      "Bulk completed aggregate",
      "completed",
    );
    expect((await taskState(bulkBlocked.aggregateTaskId)).status).toBe("blocked");
    expect((await taskState(bulkCompleted.aggregateTaskId)).status).toBe("completed");

    const bulkIdempotency = nextIdempotency("create-subtasks");
    const bulkAppend = await database.query<{ response: CreateSubtasksResponse }>(
      `select public.create_user_subtasks(
         $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        userId,
        bulkParentId,
        JSON.stringify([
          {
            client_ref: "bulk-sibling",
            title: "Bulk sibling",
            assigned_session_id: assignmentSessionId,
          },
        ]),
        bulkIdempotency.key,
        bulkIdempotency.requestHash,
      ],
    );
    const bulkSiblingId = bulkAppend.rows[0].response.subtasks[0].id;

    expect(await taskState(bulkBlocked.aggregateTaskId)).toMatchObject({
      status: "blocked",
      completed_at: null,
    });
    expect((await taskState(bulkBlocked.leafTaskId)).status).toBe("blocked");
    expect(await taskState(bulkCompleted.aggregateTaskId)).toMatchObject({
      status: "completed",
    });
    expect((await taskState(bulkSiblingId)).status).toBe("ready");
    expect((await taskState(bulkParentId)).status).toBe("ready");

    // Single-child path: retain both blocked P -> A -> A1 and waiting aggregate
    // siblings. The setup makes P appendable; recomputation after the append
    // must restore P's truthful waiting state from its unchanged child.
    const singleParentId = await createTask(null, "Single parent");
    const singleBlocked = await createAggregateBranch(
      singleParentId,
      "Single blocked aggregate",
      "blocked",
    );
    const singleWaiting = await createAggregateBranch(
      singleParentId,
      "Single waiting aggregate",
      "waiting_user",
    );
    expect((await taskState(singleWaiting.aggregateTaskId)).status).toBe("waiting_user");
    await database.query(
      `update public.tasks
       set status = 'blocked', completed_at = null
       where id = $1::uuid`,
      [singleParentId],
    );

    const singleSiblingId = await createTask(singleParentId, "Single sibling");

    expect(await taskState(singleBlocked.aggregateTaskId)).toMatchObject({
      status: "blocked",
      completed_at: null,
    });
    expect((await taskState(singleBlocked.leafTaskId)).status).toBe("blocked");
    expect((await taskState(singleWaiting.aggregateTaskId)).status).toBe("waiting_user");
    expect((await taskState(singleWaiting.leafTaskId)).status).toBe("waiting_user");
    expect((await taskState(singleSiblingId)).status).toBe("ready");
    expect((await taskState(singleParentId)).status).toBe("waiting_user");
  }, 30_000);

  it("keeps identity sequences private while service_role can insert events", async () => {
    const privileges = await database.query<{
      anon_usage: boolean;
      authenticated_usage: boolean;
      service_role_select: boolean;
      service_role_usage: boolean;
    }>(`
      select
        has_sequence_privilege('anon', 'public.task_events_id_seq', 'USAGE') as anon_usage,
        has_sequence_privilege(
          'authenticated', 'public.task_events_id_seq', 'USAGE'
        ) as authenticated_usage,
        has_sequence_privilege(
          'service_role', 'public.task_events_id_seq', 'USAGE'
        ) as service_role_usage,
        has_sequence_privilege(
          'service_role', 'public.task_events_id_seq', 'SELECT'
        ) as service_role_select
    `);

    expect(privileges.rows[0]).toEqual({
      anon_usage: false,
      authenticated_usage: false,
      service_role_usage: true,
      service_role_select: true,
    });
  });

  it("atomically closes a waiting leaf question and replays cancellation idempotently", async () => {
    const taskId = await createTask(null, "Waiting leaf to cancel");
    const waiting = await makeTaskWaitForUser(taskId, "Waiting leaf");
    expect((await taskState(taskId)).status).toBe("waiting_user");
    expect(await messageReadAt(waiting.messageId)).toBeNull();
    expect(await sessionState(waiting.sessionId)).toEqual({
      current_task_id: null,
      status: "waiting",
    });

    const idempotency = nextIdempotency("cancel-waiting-leaf");
    const firstResponse = await cancelTask(taskId, idempotency);
    const firstReadAt = await messageReadAt(waiting.messageId);

    expect(firstResponse.task.status).toBe("cancelled");
    expect(await taskState(taskId)).toMatchObject({
      status: "cancelled",
      completed_at: null,
    });
    expect(firstReadAt).not.toBeNull();
    expect(await sessionState(waiting.sessionId)).toEqual({
      current_task_id: null,
      status: "online",
    });
    expect(await cancellationEventCount([taskId])).toBe(1);

    const replayResponse = await cancelTask(taskId, idempotency);
    expect(replayResponse).toEqual(firstResponse);
    expect(await messageReadAt(waiting.messageId)).toBe(firstReadAt);
    expect(await cancellationEventCount([taskId])).toBe(1);
  });

  it("closes waiting descendant questions when cancelling their parent", async () => {
    const parentTaskId = await createTask(null, "Parent with waiting descendant");
    const waitingChildId = await createTask(parentTaskId, "Waiting descendant");
    const completedChildId = await createTask(parentTaskId, "Completed descendant");
    await database.query(
      `update public.tasks
       set status = 'completed', completed_at = now()
       where id = $1::uuid`,
      [completedChildId],
    );
    const waiting = await makeTaskWaitForUser(waitingChildId, "Waiting descendant");
    expect((await taskState(parentTaskId)).status).toBe("waiting_user");

    const idempotency = nextIdempotency("cancel-waiting-parent");
    const firstResponse = await cancelTask(parentTaskId, idempotency);
    const firstReadAt = await messageReadAt(waiting.messageId);

    expect(firstResponse.task.status).toBe("cancelled");
    expect((await taskState(parentTaskId)).status).toBe("cancelled");
    expect((await taskState(waitingChildId)).status).toBe("cancelled");
    expect((await taskState(completedChildId)).status).toBe("completed");
    expect(firstReadAt).not.toBeNull();
    expect(await sessionState(waiting.sessionId)).toEqual({
      current_task_id: null,
      status: "online",
    });
    expect(await cancellationEventCount([parentTaskId, waitingChildId])).toBe(2);

    const replayResponse = await cancelTask(parentTaskId, idempotency);
    expect(replayResponse).toEqual(firstResponse);
    expect(await messageReadAt(waiting.messageId)).toBe(firstReadAt);
    expect(await cancellationEventCount([parentTaskId, waitingChildId])).toBe(2);
  });
});

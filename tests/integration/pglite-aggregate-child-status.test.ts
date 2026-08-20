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
  let assignmentConnectionId: string;
  let assignmentSessionId: string;
  let assignmentTokenHash: string;
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
    status: "blocked" | "completed" | "paused" | "waiting_user",
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

  const createSessionFixture = async (label: string) => {
    const connectionId = randomUUID();
    const sessionId = randomUUID();
    const tokenHash = randomUUID().repeat(2);
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, created_by_user_id
       ) values ($1::uuid, $2::uuid, $3::text, 'pglite', $4::text, $5::uuid)`,
      [connectionId, workspaceId, `${label} connection`, tokenHash, userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform, status, last_seen_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::text, 'pglite', 'online',
         now() - interval '10 minutes'
       )`,
      [sessionId, workspaceId, connectionId, `${label} session`],
    );
    return { connectionId, sessionId, tokenHash };
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

      -- Minimal stand-in for the Web thread command table (created by the
      -- 20260810180000 migration, which this subset does not load) so the
      -- task-pause migration's constraint rewrite applies cleanly.
      create table public.ai_thread_commands (
        id uuid primary key default pg_catalog.gen_random_uuid(),
        workspace_id uuid,
        connection_id uuid,
        session_id uuid,
        action text not null,
        name text,
        external_thread_id text,
        platform text,
        requested_by_user_id uuid
      );
    `);

    for (const migrationName of [
      "20260808000000_initial_schema.sql",
      "20260808000100_core_functions.sql",
      "20260808000200_rls_storage.sql",
      "20260808000300_session_directed_dispatch.sql",
      "20260809141451_session_conversation_bridge.sql",
      "20260809141643_session_activity_fk_indexes.sql",
      "20260809150155_heartbeat_idempotency_maintenance.sql",
      "20260810100000_bridge_v2_thread_inventory.sql",
      "20260830000000_task_paused_status.sql",
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
    assignmentConnectionId = randomUUID();
    assignmentTokenHash = randomUUID().repeat(2);
    assignmentSessionId = randomUUID();
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, created_by_user_id
       ) values ($1::uuid, $2::uuid, 'PGlite directed connection', 'pglite', $3::text, $4::uuid)`,
      [assignmentConnectionId, workspaceId, assignmentTokenHash, userId],
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

  it("keeps the session activity write surface private", async () => {
    const privileges = await database.query<{
      anon_can_call_helper: boolean;
      anon_can_call_report: boolean;
      anon_can_call_turn: boolean;
      anon_can_use_sequence: boolean;
      authenticated_can_insert: boolean;
      authenticated_can_select: boolean;
      authenticated_can_use_sequence: boolean;
      service_can_call_report: boolean;
      service_can_call_turn: boolean;
    }>(
      `select
         has_function_privilege(
           'anon', 'public._reject_session_activity_mutation()', 'execute'
         ) as anon_can_call_helper,
         has_function_privilege(
           'anon',
           'public.report_session_activity(uuid,uuid,text,uuid,uuid,text,text,text,jsonb,text,text,text)',
           'execute'
         ) as anon_can_call_report,
         has_function_privilege(
           'anon',
           'public.create_session_turn(uuid,uuid,uuid,text,text,integer,text,text)',
           'execute'
         ) as anon_can_call_turn,
         has_function_privilege(
           'service_role',
           'public.report_session_activity(uuid,uuid,text,uuid,uuid,text,text,text,jsonb,text,text,text)',
           'execute'
         ) as service_can_call_report,
         has_function_privilege(
           'service_role',
           'public.create_session_turn(uuid,uuid,uuid,text,text,integer,text,text)',
           'execute'
         ) as service_can_call_turn,
         has_table_privilege(
           'authenticated', 'public.session_activities', 'select'
         ) as authenticated_can_select,
         has_table_privilege(
           'authenticated', 'public.session_activities', 'insert'
         ) as authenticated_can_insert,
         has_sequence_privilege(
           'anon', 'public.session_activities_id_seq', 'usage'
         ) as anon_can_use_sequence,
         has_sequence_privilege(
           'authenticated', 'public.session_activities_id_seq', 'usage'
         ) as authenticated_can_use_sequence`,
    );

    expect(privileges.rows[0]).toEqual({
      anon_can_call_helper: false,
      anon_can_call_report: false,
      anon_can_call_turn: false,
      anon_can_use_sequence: false,
      authenticated_can_insert: false,
      authenticated_can_select: true,
      authenticated_can_use_sequence: false,
      service_can_call_report: true,
      service_can_call_turn: true,
    });
  });

  it("synchronizes a full Bridge thread inventory without deleting history", async () => {
    const fixture = await createSessionFixture("Inventory");
    const firstIdempotency = nextIdempotency("sync-inventory-first");
    const firstThreads = [
      {
        external_conversation_ref: "codex-thread-alpha",
        name: "Alpha",
        platform: "codex",
        model: "gpt-5",
        working_directory: "/srv/alpha",
        capabilities: ["coding", "shell"],
        archived: false,
      },
      {
        external_conversation_ref: "codex-thread-beta",
        name: "Beta",
        platform: "codex",
        model: null,
        working_directory: "/srv/beta",
        capabilities: [],
        archived: false,
      },
    ];
    const first = await database.query<{
      response: {
        connection: { bridge_version: string; last_seen_at: string };
        sessions: Array<{
          external_conversation_ref: string;
          id: string;
          inventory_active: boolean;
          status: string;
        }>;
      };
    }>(
      `select public.sync_ai_sessions(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::jsonb,
         $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        "0.2.0",
        JSON.stringify(firstThreads),
        firstIdempotency.key,
        firstIdempotency.requestHash,
      ],
    );

    expect(first.rows[0].response.connection).toMatchObject({
      bridge_version: "0.2.0",
    });
    expect(first.rows[0].response.connection.last_seen_at).toBeTruthy();
    expect(first.rows[0].response.sessions).toHaveLength(2);
    const alphaSessionId = first.rows[0].response.sessions.find(
      (session) => session.external_conversation_ref === "codex-thread-alpha",
    )?.id;
    const betaSessionId = first.rows[0].response.sessions.find(
      (session) => session.external_conversation_ref === "codex-thread-beta",
    )?.id;
    expect(alphaSessionId).toBeTruthy();
    expect(betaSessionId).toBeTruthy();

    const secondIdempotency = nextIdempotency("sync-inventory-second");
    const second = await database.query<{
      response: {
        sessions: Array<{
          archived_at: string | null;
          external_conversation_ref: string;
          id: string;
          inventory_active: boolean;
          status: string;
          working_directory: string | null;
        }>;
      };
    }>(
      `select public.sync_ai_sessions(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::jsonb,
         $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        "0.2.1",
        JSON.stringify([
          {
            ...firstThreads[0],
            name: "Alpha renamed",
            working_directory: "/srv/alpha-renamed",
          },
        ]),
        secondIdempotency.key,
        secondIdempotency.requestHash,
      ],
    );

    expect(second.rows[0].response.sessions).toEqual([
      expect.objectContaining({
        archived_at: null,
        external_conversation_ref: "codex-thread-alpha",
        id: alphaSessionId,
        inventory_active: true,
        status: "online",
        working_directory: "/srv/alpha-renamed",
      }),
    ]);

    const retained = await database.query<{
      archived_at: string | null;
      external_conversation_ref: string | null;
      id: string;
      inventory_active: boolean;
      status: string;
    }>(
      `select id, external_conversation_ref, status::text, archived_at::text,
              inventory_active
       from public.ai_sessions
       where connection_id = $1::uuid
       order by created_at, id`,
      [fixture.connectionId],
    );
    expect(retained.rows).toHaveLength(3);
    expect(
      retained.rows.find((session) => session.id === betaSessionId),
    ).toMatchObject({ inventory_active: false, status: "offline" });
    expect(
      retained.rows.find((session) => session.id === fixture.sessionId),
    ).toMatchObject({
      external_conversation_ref: null,
      inventory_active: false,
      status: "offline",
    });

    const omittedHeartbeat = nextIdempotency("omitted-session-heartbeat");
    await expect(
      database.query(
        `select public.heartbeat_ai_session(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          fixture.tokenHash,
          betaSessionId,
          omittedHeartbeat.key,
          omittedHeartbeat.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const restoreIdempotency = nextIdempotency("sync-inventory-restore");
    const restored = await database.query<{
      response: {
        sessions: Array<{
          external_conversation_ref: string;
          id: string;
          inventory_active: boolean;
          status: string;
        }>;
      };
    }>(
      `select public.sync_ai_sessions(
         $1::uuid, $2::uuid, $3::text, '0.2.1', $4::jsonb,
         $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        JSON.stringify(firstThreads),
        restoreIdempotency.key,
        restoreIdempotency.requestHash,
      ],
    );
    expect(
      restored.rows[0].response.sessions.find(
        (session) => session.external_conversation_ref === "codex-thread-beta",
      ),
    ).toMatchObject({
      id: betaSessionId,
      inventory_active: true,
      status: "online",
    });

    const restoredHeartbeat = nextIdempotency("restored-session-heartbeat");
    await database.query(
      `select public.heartbeat_ai_session(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::text
       )`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        betaSessionId,
        restoredHeartbeat.key,
        restoredHeartbeat.requestHash,
      ],
    );

    const archiveIdempotency = nextIdempotency("sync-inventory-archive");
    const archived = await database.query<{
      response: {
        sessions: Array<{
          archived_at: string | null;
          id: string;
          inventory_active: boolean;
          status: string;
        }>;
      };
    }>(
      `select public.sync_ai_sessions(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::jsonb,
         $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        "0.2.1",
        JSON.stringify([{ ...firstThreads[0], archived: true }]),
        archiveIdempotency.key,
        archiveIdempotency.requestHash,
      ],
    );
    expect(archived.rows[0].response.sessions[0]).toMatchObject({
      id: alphaSessionId,
      inventory_active: false,
      status: "offline",
    });
    expect(archived.rows[0].response.sessions[0]?.archived_at).toBeTruthy();

    const archivedHeartbeat = nextIdempotency("archived-session-heartbeat");
    await expect(
      database.query(
        `select public.heartbeat_ai_session(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          fixture.tokenHash,
          alphaSessionId,
          archivedHeartbeat.key,
          archivedHeartbeat.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const v1Registration = nextIdempotency("v1-register-reactivation");
    const registered = await database.query<{
      response: {
        session: {
          archived_at: string | null;
          id: string;
          inventory_active: boolean;
          status: string;
        };
      };
    }>(
      `select public.register_ai_session(
         $1::uuid, $2::uuid, $3::text, 'Alpha via V1', 'codex', null,
         'codex-thread-alpha', '{}'::text[], $4::text, $5::text
       ) as response`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        v1Registration.key,
        v1Registration.requestHash,
      ],
    );
    expect(registered.rows[0].response.session).toMatchObject({
      archived_at: null,
      id: alphaSessionId,
      inventory_active: true,
      status: "online",
    });

    const idempotencyRows = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.idempotency_records
       where workspace_id = $1::uuid
         and actor_key = 'connection:' || $2::uuid::text
         and idempotency_key = any($3::text[])`,
      [
        workspaceId,
        fixture.connectionId,
        [
          firstIdempotency.key,
          secondIdempotency.key,
          restoreIdempotency.key,
          archiveIdempotency.key,
        ],
      ],
    );
    expect(idempotencyRows.rows[0].count).toBe(0);

    await expect(
      database.query(
        `select public.sync_ai_sessions(
           $1::uuid, $2::uuid, $3::text, '0.2.1', '[]'::jsonb,
           'pglite/sync/wrong-token', $4::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          "wrong-token-hash".padEnd(64, "0"),
          "wrong-token-request".padEnd(64, "0"),
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const privileges = await database.query<{
      anon_can_assert: boolean;
      anon_can_call: boolean;
      anon_can_register: boolean;
      authenticated_can_assert: boolean;
      authenticated_can_read_inventory: boolean;
      authenticated_can_read_presence: boolean;
      service_can_register: boolean;
      service_can_call: boolean;
    }>(
      `select
         has_function_privilege(
           'anon',
           'public._assert_active_session(uuid,uuid,text,uuid)',
           'execute'
         ) as anon_can_assert,
         has_function_privilege(
           'authenticated',
           'public._assert_active_session(uuid,uuid,text,uuid)',
           'execute'
         ) as authenticated_can_assert,
         has_function_privilege(
           'anon',
           'public.sync_ai_sessions(uuid,uuid,text,text,jsonb,text,text)',
           'execute'
         ) as anon_can_call,
         has_function_privilege(
           'service_role',
           'public.sync_ai_sessions(uuid,uuid,text,text,jsonb,text,text)',
           'execute'
         ) as service_can_call,
         has_function_privilege(
           'anon',
           'public.register_ai_session(uuid,uuid,text,text,text,text,text,text[],text,text)',
           'execute'
         ) as anon_can_register,
         has_function_privilege(
           'service_role',
           'public.register_ai_session(uuid,uuid,text,text,text,text,text,text[],text,text)',
           'execute'
         ) as service_can_register,
         has_column_privilege(
           'authenticated', 'public.ai_connections', 'last_seen_at', 'select'
         ) as authenticated_can_read_presence,
         has_column_privilege(
           'authenticated', 'public.ai_sessions', 'inventory_active', 'select'
         ) as authenticated_can_read_inventory`,
    );
    expect(privileges.rows[0]).toEqual({
      anon_can_assert: false,
      anon_can_call: false,
      anon_can_register: false,
      authenticated_can_assert: false,
      authenticated_can_read_inventory: true,
      authenticated_can_read_presence: true,
      service_can_call: true,
      service_can_register: true,
    });
  });

  it("finishes release before the final inventory omission and fences late writes", async () => {
    const fixture = await createSessionFixture("Inventory shutdown");
    const initialSync = nextIdempotency("shutdown-inventory-initial");
    const synced = await database.query<{
      response: { sessions: Array<{ id: string; inventory_active: boolean }> };
    }>(
      `select public.sync_ai_sessions(
         $1::uuid, $2::uuid, $3::text, '0.2.1', $4::jsonb,
         $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        JSON.stringify([
          {
            external_conversation_ref: "codex-thread-shutdown",
            name: "Shutdown thread",
          },
        ]),
        initialSync.key,
        initialSync.requestHash,
      ],
    );
    const sessionId = synced.rows[0].response.sessions[0].id;
    expect(synced.rows[0].response.sessions[0].inventory_active).toBe(true);

    const taskId = randomUUID();
    await database.query(
      `insert into public.tasks (
         id, workspace_id, root_task_id, title, status,
         assigned_session_id, created_by_type
       ) values (
         $1::uuid, $2::uuid, $1::uuid, 'Release before omission', 'ready',
         $3::uuid, 'system'
       )`,
      [taskId, workspaceId, sessionId],
    );
    const claimTokenHash = randomUUID().repeat(2);
    const claimIdempotency = nextIdempotency("shutdown-claim");
    await database.query(
      `select public.claim_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
         $6::text, 900, $7::text, $8::text
       )`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        sessionId,
        taskId,
        claimTokenHash,
        claimIdempotency.key,
        claimIdempotency.requestHash,
      ],
    );

    // Shutdown ordering is part of the fencing contract: release commits
    // while the session still owns a shared inventory fence, then the final
    // empty snapshot takes the exclusive fence and becomes authoritative.
    const releaseIdempotency = nextIdempotency("shutdown-release");
    await database.query(
      `select public.release_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
         $6::text, 'Bridge shutdown', $7::text, $8::text
       )`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        sessionId,
        taskId,
        claimTokenHash,
        releaseIdempotency.key,
        releaseIdempotency.requestHash,
      ],
    );
    expect(await taskState(taskId)).toMatchObject({ status: "ready" });

    const finalSync = nextIdempotency("shutdown-inventory-final");
    await database.query(
      `select public.sync_ai_sessions(
         $1::uuid, $2::uuid, $3::text, '0.2.1', '[]'::jsonb,
         $4::text, $5::text
       )`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        finalSync.key,
        finalSync.requestHash,
      ],
    );

    const inactive = await database.query<{
      current_task_id: string | null;
      inventory_active: boolean;
      status: string;
    }>(
      `select current_task_id, inventory_active, status::text
       from public.ai_sessions where id = $1::uuid`,
      [sessionId],
    );
    expect(inactive.rows[0]).toEqual({
      current_task_id: null,
      inventory_active: false,
      status: "offline",
    });

    // Even if another cleanup temporarily writes a fresh-looking status, both
    // idle derivation and Web dispatch must honor the authoritative fence.
    await database.query(
      `update public.ai_sessions
       set status = 'online', last_seen_at = now()
       where id = $1::uuid`,
      [sessionId],
    );
    const derivedIdle = await database.query<{ status: string }>(
      `select public._idle_session_status($1::uuid)::text as status`,
      [sessionId],
    );
    expect(derivedIdle.rows[0].status).toBe("offline");

    const rejectedTurn = nextIdempotency("shutdown-rejected-turn");
    await expect(
      database.query(
        `select public.create_session_turn(
           $1::uuid, $2::uuid, $3::uuid, 'Late Web turn', 'must be rejected',
           50, $4::text, $5::text
         )`,
        [
          workspaceId,
          userId,
          sessionId,
          rejectedTurn.key,
          rejectedTurn.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");
    await expect(
      database.query(
        `insert into public.tasks (
           id, workspace_id, root_task_id, title, status,
           assigned_session_id, created_by_type, created_by_id
         ) values (
           $1::uuid, $2::uuid, $1::uuid, 'Direct late assignment', 'ready',
           $3::uuid, 'user', $4::uuid
         )`,
        [randomUUID(), workspaceId, sessionId, userId],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");
    await database.query(
      `update public.ai_sessions
       set status = public._idle_session_status(id)
       where id = $1::uuid`,
      [sessionId],
    );

    const lateHeartbeat = nextIdempotency("shutdown-late-heartbeat");
    await expect(
      database.query(
        `select public.heartbeat_ai_session(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          fixture.tokenHash,
          sessionId,
          lateHeartbeat.key,
          lateHeartbeat.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const lateRelease = nextIdempotency("shutdown-late-release");
    await expect(
      database.query(
        `select public.release_task(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
           $6::text, 'late release', $7::text, $8::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          fixture.tokenHash,
          sessionId,
          taskId,
          claimTokenHash,
          lateRelease.key,
          lateRelease.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const lateActivity = nextIdempotency("shutdown-late-activity");
    await expect(
      database.query(
        `select public.report_session_activity(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text,
           'status', null, '{}'::jsonb, 'codex:late-activity',
           $7::text, $8::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          fixture.tokenHash,
          sessionId,
          taskId,
          claimTokenHash,
          lateActivity.key,
          lateActivity.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const finalState = await database.query<{
      activity_count: number;
      inventory_active: boolean;
      status: string;
      task_status: string;
    }>(
      `select
         session.inventory_active,
         session.status::text,
         task.status::text as task_status,
         (select count(*)::integer from public.session_activities activity
          where activity.external_ref = 'codex:late-activity') as activity_count
       from public.ai_sessions session
       join public.tasks task on task.id = $2::uuid
       where session.id = $1::uuid`,
      [sessionId, taskId],
    );
    expect(finalState.rows[0]).toEqual({
      activity_count: 0,
      inventory_active: false,
      status: "offline",
      task_status: "ready",
    });
  });

  it("refreshes session and claim heartbeats without audit-row churn", async () => {
    const fixture = await createSessionFixture("Heartbeat");
    const taskId = randomUUID();
    await database.query(
      `insert into public.tasks (
         id, workspace_id, root_task_id, title, status,
         assigned_session_id, created_by_type
       ) values (
         $1::uuid, $2::uuid, $1::uuid, 'Heartbeat task', 'ready',
         $3::uuid, 'system'
       )`,
      [taskId, workspaceId, fixture.sessionId],
    );

    const sessionHeartbeat = nextIdempotency("session-heartbeat");
    const firstSessionHeartbeat = await database.query<{
      response: { session: { id: string; status: string } };
    }>(
      `select public.heartbeat_ai_session(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        fixture.sessionId,
        sessionHeartbeat.key,
        sessionHeartbeat.requestHash,
      ],
    );
    expect(firstSessionHeartbeat.rows[0].response.session).toMatchObject({
      id: fixture.sessionId,
      status: "online",
    });
    await database.query(
      `select public.heartbeat_ai_session(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::text
       )`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        fixture.sessionId,
        sessionHeartbeat.key,
        "session-heartbeat-retry".padEnd(64, "0"),
      ],
    );
    await expect(
      database.query(
        `select public.heartbeat_ai_session(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          "wrong-connection-token".padEnd(64, "0"),
          fixture.sessionId,
          sessionHeartbeat.key,
          sessionHeartbeat.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");
    await expect(
      database.query(
        `select public.heartbeat_ai_session(
           $1::uuid, $2::uuid, $3::text, $4::uuid, ''::text, $5::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          fixture.tokenHash,
          fixture.sessionId,
          sessionHeartbeat.requestHash,
        ],
      ),
    ).rejects.toThrow("INVALID_IDEMPOTENCY_KEY");

    const claimTokenHash = randomUUID().repeat(2);
    const claimIdempotency = nextIdempotency("heartbeat-task-claim");
    const claimParameters = [
      workspaceId,
      fixture.connectionId,
      fixture.tokenHash,
      fixture.sessionId,
      claimTokenHash,
      900,
      claimIdempotency.key,
      claimIdempotency.requestHash,
    ];
    const claimed = await database.query<{ response: { task: TaskPayload } }>(
      `select public.claim_next_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      claimParameters,
    );
    const replay = await database.query<{ response: { task: TaskPayload } }>(
      `select public.claim_next_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      claimParameters,
    );
    expect(claimed.rows[0].response.task.id).toBe(taskId);
    expect(replay.rows[0].response).toEqual(claimed.rows[0].response);

    const claimHeartbeat = nextIdempotency("claim-heartbeat");
    await database.query(
      `select public.heartbeat_claim(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
         $6::text, 3600, $7::text, $8::text
       )`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        fixture.sessionId,
        taskId,
        claimTokenHash,
        claimHeartbeat.key,
        claimHeartbeat.requestHash,
      ],
    );
    await database.query(
      `select public.heartbeat_claim(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
         $6::text, 60, $7::text, $8::text
       )`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        fixture.sessionId,
        taskId,
        claimTokenHash,
        claimHeartbeat.key,
        "claim-heartbeat-retry".padEnd(64, "0"),
      ],
    );

    const churn = await database.query<{
      claim_heartbeat_events: number;
      claim_idempotency_records: number;
      heartbeat_idempotency_records: number;
      lease_extended: boolean;
    }>(
      `select
         (select count(*)::integer from public.idempotency_records
          where workspace_id = $1::uuid
            and actor_key = 'session:' || $2::uuid::text
            and operation = 'heartbeat_ai_session') as heartbeat_idempotency_records,
         (select count(*)::integer from public.idempotency_records
          where workspace_id = $1::uuid
            and actor_key = 'session:' || $2::uuid::text
            and operation = 'heartbeat_claim') as claim_idempotency_records,
         (select count(*)::integer from public.task_events
          where task_id = $3::uuid and type = 'claim_heartbeat') as claim_heartbeat_events,
         (select lease_expires_at > now() + interval '50 minutes'
          from public.tasks where id = $3::uuid) as lease_extended`,
      [workspaceId, fixture.sessionId, taskId],
    );
    expect(churn.rows[0]).toEqual({
      claim_heartbeat_events: 0,
      claim_idempotency_records: 0,
      heartbeat_idempotency_records: 0,
      lease_extended: true,
    });

    await expect(
      database.query(
        `select public.heartbeat_claim(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
           $6::text, 900, 'invalid-token-check', $7::text
         )`,
        [
          workspaceId,
          fixture.connectionId,
          fixture.tokenHash,
          fixture.sessionId,
          taskId,
          "wrong-claim-token".padEnd(64, "0"),
          "invalid-token-check".padEnd(64, "0"),
        ],
      ),
    ).rejects.toThrow("INVALID_CLAIM_TOKEN");
  });

  it("does not cache an empty claim poll but caches a real claim", async () => {
    const fixture = await createSessionFixture("Empty claim");
    const claimTokenHash = randomUUID().repeat(2);
    const idempotency = nextIdempotency("empty-then-real-claim");
    const parameters = [
      workspaceId,
      fixture.connectionId,
      fixture.tokenHash,
      fixture.sessionId,
      claimTokenHash,
      900,
      idempotency.key,
      idempotency.requestHash,
    ];
    const empty = await database.query<{ response: { task: TaskPayload | null } }>(
      `select public.claim_next_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      parameters,
    );
    expect(empty.rows[0].response.task).toBeNull();

    const afterEmpty = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.idempotency_records
       where workspace_id = $1::uuid
         and actor_key = 'session:' || $2::uuid::text
         and idempotency_key = $3::text`,
      [workspaceId, fixture.sessionId, idempotency.key],
    );
    expect(afterEmpty.rows[0].count).toBe(0);

    const taskId = randomUUID();
    await database.query(
      `insert into public.tasks (
         id, workspace_id, root_task_id, title, status,
         assigned_session_id, created_by_type
       ) values (
         $1::uuid, $2::uuid, $1::uuid, 'Appeared after empty poll', 'ready',
         $3::uuid, 'system'
       )`,
      [taskId, workspaceId, fixture.sessionId],
    );
    const claimed = await database.query<{ response: { task: TaskPayload } }>(
      `select public.claim_next_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      parameters,
    );
    const replay = await database.query<{ response: { task: TaskPayload } }>(
      `select public.claim_next_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      parameters,
    );
    expect(claimed.rows[0].response.task.id).toBe(taskId);
    expect(replay.rows[0].response).toEqual(claimed.rows[0].response);

    const afterClaim = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.idempotency_records
       where workspace_id = $1::uuid
         and actor_key = 'session:' || $2::uuid::text
         and idempotency_key = $3::text
         and response_json is not null`,
      [workspaceId, fixture.sessionId, idempotency.key],
    );
    expect(afterClaim.rows[0].count).toBe(1);

    await database.query(
      `update public.tasks
       set status = 'completed', completed_at = now(),
           claimed_by_session_id = null, claim_token_hash = null,
           claimed_at = null, lease_expires_at = null
       where id = $1::uuid`,
      [taskId],
    );
    await database.query(
      `update public.ai_sessions
       set current_task_id = null, status = 'online'
       where id = $1::uuid`,
      [fixture.sessionId],
    );
    const replayAfterCompletion = await database.query<{
      response: { task: TaskPayload };
    }>(
      `select public.claim_next_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      parameters,
    );
    expect(replayAfterCompletion.rows[0].response).toEqual(
      claimed.rows[0].response,
    );

    await expect(
      database.query(
        `select public.claim_next_task(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
           $6::integer, $7::text, $8::text
         )`,
        [
          ...parameters.slice(0, 7),
          "conflicting-empty-queue-retry".padEnd(64, "0"),
        ],
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });

  it("cleans expired idempotency rows in private bounded batches", async () => {
    const actorKey = `cleanup-test:${randomUUID()}`;
    await database.query(
      `insert into public.idempotency_records (
         workspace_id, actor_key, idempotency_key, operation, request_hash,
         response_json, expires_at
       ) values
         ($1::uuid, $2::text, 'expired-1', 'cleanup-test', $3::text, '{}'::jsonb, '2000-01-01'),
         ($1::uuid, $2::text, 'expired-2', 'cleanup-test', $3::text, '{}'::jsonb, '2000-01-02'),
         ($1::uuid, $2::text, 'future', 'cleanup-test', $3::text, '{}'::jsonb, '2099-01-01')`,
      [workspaceId, actorKey, "cleanup-test".padEnd(64, "0")],
    );

    const first = await database.query<{ deleted: number }>(
      "select public.cleanup_expired_idempotency_records(1) as deleted",
    );
    const second = await database.query<{ deleted: number }>(
      "select public.cleanup_expired_idempotency_records(1) as deleted",
    );
    expect(first.rows[0].deleted).toBe(1);
    expect(second.rows[0].deleted).toBe(1);

    const remaining = await database.query<{ idempotency_key: string }>(
      `select idempotency_key
       from public.idempotency_records
       where workspace_id = $1::uuid and actor_key = $2::text`,
      [workspaceId, actorKey],
    );
    expect(remaining.rows).toEqual([{ idempotency_key: "future" }]);

    const privileges = await database.query<{
      anon_can_cleanup: boolean;
      authenticated_can_cleanup: boolean;
      service_can_cleanup: boolean;
    }>(
      `select
         has_function_privilege(
           'anon', 'public.cleanup_expired_idempotency_records(integer)', 'execute'
         ) as anon_can_cleanup,
         has_function_privilege(
           'authenticated',
           'public.cleanup_expired_idempotency_records(integer)', 'execute'
         ) as authenticated_can_cleanup,
         has_function_privilege(
           'service_role',
           'public.cleanup_expired_idempotency_records(integer)', 'execute'
         ) as service_can_cleanup`,
    );
    expect(privileges.rows[0]).toEqual({
      anon_can_cleanup: false,
      authenticated_can_cleanup: false,
      service_can_cleanup: false,
    });
    await expect(
      database.query("select public.cleanup_expired_idempotency_records(0)"),
    ).rejects.toThrow("INVALID_REQUEST");
  });

  it("rejects new turns for a revoked connection even if its session row looks live", async () => {
    const revokedConnectionId = randomUUID();
    const staleSessionId = randomUUID();
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, created_by_user_id,
         revoked_at
       ) values (
         $1::uuid, $2::uuid, 'Revoked connection', 'pglite', $3::text,
         $4::uuid, now()
       )`,
      [revokedConnectionId, workspaceId, randomUUID().repeat(2), userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform, status, last_seen_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'Stale live session', 'pglite',
         'online', now()
       )`,
      [staleSessionId, workspaceId, revokedConnectionId],
    );
    const idempotency = nextIdempotency("revoked-session-turn");

    await expect(
      database.query(
        `select public.create_session_turn(
           $1::uuid, $2::uuid, $3::uuid, 'Must reject', 'Do not enqueue',
           50, $4::text, $5::text
         )`,
        [
          workspaceId,
          userId,
          staleSessionId,
          idempotency.key,
          idempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");
    const partialWrites = await database.query<{
      idempotency_records: number;
      tasks: number;
    }>(
      `select
         (select count(*)::integer from public.tasks where title = 'Must reject') as tasks,
         (select count(*)::integer
          from public.idempotency_records
          where workspace_id = $1::uuid
            and actor_key = 'user:' || $2::uuid::text
            and idempotency_key = $3::text) as idempotency_records`,
      [workspaceId, userId, idempotency.key],
    );
    expect(partialWrites.rows[0]).toEqual({ idempotency_records: 0, tasks: 0 });
  });

  it("atomically creates and idempotently replays a session chat turn", async () => {
    const idempotency = nextIdempotency("create-session-turn");
    const parameters = [
      workspaceId,
      userId,
      assignmentSessionId,
      "自动任务名称",
      "请修复会话派发链路",
      50,
      idempotency.key,
      idempotency.requestHash,
    ];
    const first = await database.query<{
      response: {
        activity: {
          external_ref: string;
          id: number;
          kind: string;
          session_id: string;
          task_id: string;
          task_message_id: string;
        };
        message: { id: string; content: string; task_id: string };
        task: TaskPayload & { assigned_session_id: string };
      };
    }>(
      `select public.create_session_turn(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      parameters,
    );
    const replay = await database.query<{ response: unknown }>(
      `select public.create_session_turn(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      parameters,
    );

    expect(first.rows[0].response).toMatchObject({
      task: { assigned_session_id: assignmentSessionId, status: "ready" },
      message: {
        content: "请修复会话派发链路",
        task_id: first.rows[0].response.task.id,
      },
      activity: {
        kind: "user_message",
        session_id: assignmentSessionId,
        task_id: first.rows[0].response.task.id,
      },
    });
    expect(replay.rows[0].response).toEqual(first.rows[0].response);
    await expect(
      database.query(
        `select public.create_session_turn(
           $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
           $6::integer, $7::text, $8::text
         )`,
        [
          ...parameters.slice(0, 4),
          "不同的消息",
          ...parameters.slice(5, 7),
          "conflicting-request-hash".padEnd(64, "0"),
        ],
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await database.query(
      `update public.idempotency_records
       set expires_at = now() - interval '1 second'
       where workspace_id = $1::uuid
         and actor_key = 'user:' || $2::uuid::text
         and idempotency_key = $3::text`,
      [workspaceId, userId, idempotency.key],
    );
    const afterExpiry = await database.query<{
      response: { activity: { external_ref: string }; task: TaskPayload };
    }>(
      `select public.create_session_turn(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      parameters,
    );
    expect(afterExpiry.rows[0].response.task.id).not.toBe(
      first.rows[0].response.task.id,
    );
    expect(afterExpiry.rows[0].response.activity.external_ref).not.toBe(
      first.rows[0].response.activity.external_ref,
    );
    const counts = await database.query<{ activities: number; messages: number; tasks: number }>(
      `select
         (select count(*)::integer from public.tasks where title = '自动任务名称') as tasks,
         (select count(*)::integer from public.task_messages where content = '请修复会话派发链路') as messages,
         (select count(*)::integer from public.session_activities where content = '请修复会话派发链路') as activities`,
    );
    expect(counts.rows[0]).toEqual({ tasks: 2, messages: 2, activities: 2 });
  });

  it("records Harness summaries and assistant messages once per external item", async () => {
    await database.query(
      `update public.tasks
       set status = 'ready', claimed_by_session_id = null,
           claim_token_hash = null, claimed_at = null, lease_expires_at = null
       where claimed_by_session_id = $1::uuid
         and status in ('claimed', 'running')`,
      [assignmentSessionId],
    );
    await database.query(
      `update public.ai_sessions
       set current_task_id = null, status = 'online'
       where id = $1::uuid`,
      [assignmentSessionId],
    );
    const createIdempotency = nextIdempotency("activity-task");
    const created = await database.query<{ response: CreateTaskResponse }>(
      `select public.create_session_turn(
         $1::uuid, $2::uuid, $3::uuid, 'Activity task', 'Run the bridge',
         50, $4::text, $5::text
       ) as response`,
      [
        workspaceId,
        userId,
        assignmentSessionId,
        createIdempotency.key,
        createIdempotency.requestHash,
      ],
    );
    const taskId = created.rows[0].response.task.id;
    const claimHash = randomUUID().repeat(2);
    await database.query(
      `select public._claim_task_internal($1::uuid, $2::uuid, $3::uuid, $4::text, 900)`,
      [workspaceId, assignmentSessionId, taskId, claimHash],
    );

    const otherConnectionId = randomUUID();
    const otherSessionId = randomUUID();
    const otherTokenHash = randomUUID().repeat(2);
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, created_by_user_id
       ) values ($1::uuid, $2::uuid, 'Other connection', 'pglite', $3::text, $4::uuid)`,
      [otherConnectionId, workspaceId, otherTokenHash, userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform, status, last_seen_at
       ) values ($1::uuid, $2::uuid, $3::uuid, 'Other session', 'pglite', 'online', now())`,
      [otherSessionId, workspaceId, otherConnectionId],
    );

    const unauthorizedIdempotency = nextIdempotency("unauthorized-activity");
    await expect(
      database.query(
        `select public.report_session_activity(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text,
           'reasoning', 'wrong owner', '{}'::jsonb, 'codex:item:wrong-owner',
           $7::text, $8::text
         )`,
        [
          workspaceId,
          otherConnectionId,
          otherTokenHash,
          otherSessionId,
          taskId,
          claimHash,
          unauthorizedIdempotency.key,
          unauthorizedIdempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const invalidKindIdempotency = nextIdempotency("invalid-activity-kind");
    await expect(
      database.query(
        `select public.report_session_activity(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text,
           null::text, null::text, '{}'::jsonb, 'codex:item:null-kind',
           $7::text, $8::text
         )`,
        [
          workspaceId,
          assignmentConnectionId,
          assignmentTokenHash,
          assignmentSessionId,
          taskId,
          claimHash,
          invalidKindIdempotency.key,
          invalidKindIdempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("INVALID_REQUEST");

    const oversizedDataIdempotency = nextIdempotency("oversized-activity-data");
    await expect(
      database.query(
        `select public.report_session_activity(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text,
           'status', null::text, $7::jsonb, 'codex:item:oversized-data',
           $8::text, $9::text
         )`,
        [
          workspaceId,
          assignmentConnectionId,
          assignmentTokenHash,
          assignmentSessionId,
          taskId,
          claimHash,
          JSON.stringify({ payload: "x".repeat(262_144) }),
          oversizedDataIdempotency.key,
          oversizedDataIdempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("INVALID_REQUEST");

    const report = async (
      kind: "reasoning" | "assistant_message",
      content: string,
      externalRef: string,
      data: Record<string, unknown> = {},
      idempotency = nextIdempotency("session-activity"),
    ) => database.query<{
      response: {
        activity: { content: string | null; id: number; kind: string };
        message: { id: string; content: string } | null;
        task: TaskPayload | { id: string };
      };
    }>(
      `select public.report_session_activity(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text,
         $7::text, $8::text, $9::jsonb, $10::text, $11::text, $12::text
       ) as response`,
      [
        workspaceId,
        assignmentConnectionId,
        assignmentTokenHash,
        assignmentSessionId,
        taskId,
        claimHash,
        kind,
        content,
        JSON.stringify(data),
        externalRef,
        idempotency.key,
        idempotency.requestHash,
      ],
    );

    const reasoning = await report("reasoning", "正在检查失败测试", "codex:item:reasoning-1");
    expect(reasoning.rows[0].response).toMatchObject({
      activity: { kind: "reasoning" },
      message: null,
    });
    const streamControlBefore = await database.query<{
      idempotency_count: number;
      event_count: number;
    }>(
      `select
         (select count(*)::int from public.idempotency_records
          where operation = 'report_session_activity') as idempotency_count,
         (select count(*)::int from public.task_events
          where task_id = $1::uuid and type = 'session_activity_reported') as event_count`,
      [taskId],
    );

    // The high-frequency branches must not invoke the recursive task payload,
    // including when the external reference is replayed.
    await database.query("begin");
    try {
      await database.query(
        `create or replace function public._task_payload(p_task_id uuid)
         returns jsonb
         language plpgsql
         stable
         security definer
         set search_path = pg_catalog, public
         as $$
         begin
           raise exception 'TASK_PAYLOAD_CALLED';
         end;
         $$`,
      );
      for (const probe of [
        { phase: "started", content: "starting", suffix: "started" },
        { phase: "delta", content: "probe ", suffix: "delta" },
      ]) {
        const data = {
          protocol: "codex-app-server/v1",
          phase: probe.phase,
          turn_ref: "turn-probe",
          item_ref: `message-${probe.suffix}`,
        };
        const externalRef = `codex:item:probe:${probe.suffix}`;
        const first = await report(
          "assistant_message",
          probe.content,
          externalRef,
          data,
        );
        const duplicate = await report(
          "assistant_message",
          probe.content,
          externalRef,
          data,
        );
        expect(first.rows[0].response).toMatchObject({ message: null });
        expect(first.rows[0].response.task).toEqual({ id: taskId });
        expect(duplicate.rows[0].response).toEqual(first.rows[0].response);
      }
    } finally {
      await database.query("rollback");
    }

    const deltaBaseData = {
      protocol: "codex-app-server/v1",
      phase: "delta",
      turn_ref: "turn-1",
      item_ref: "message-1",
    };
    const deltaChunks = ["Hello ", "world", "\n", "  "];
    const deltaResponses = [];
    for (const [chunkIndex, content] of deltaChunks.entries()) {
      deltaResponses.push(
        await report(
          "assistant_message",
          content,
          `codex:item:message-1:delta:${chunkIndex}`,
          { ...deltaBaseData, chunk_index: chunkIndex },
        ),
      );
    }
    for (const [chunkIndex, response] of deltaResponses.entries()) {
      expect(response.rows[0].response).toMatchObject({
        activity: {
          content: deltaChunks[chunkIndex],
          kind: "assistant_message",
        },
        message: null,
      });
      expect(response.rows[0].response.task).toEqual({ id: taskId });
    }
    const firstDeltaReplay = await report(
      "assistant_message",
      "Hello ",
      "codex:item:message-1:delta:0",
      { ...deltaBaseData, chunk_index: 0 },
    );
    expect(firstDeltaReplay.rows[0].response).toEqual(
      deltaResponses[0].rows[0].response,
    );
    await expect(
      report(
        "assistant_message",
        "Hello",
        "codex:item:message-1:delta:0",
        { ...deltaBaseData, chunk_index: 0 },
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const streamedContent = await database.query<{ content: string }>(
      `select string_agg(activity.content, '' order by (activity.data ->> 'chunk_index')::int) as content
       from public.session_activities activity
       where activity.task_id = $1::uuid
         and activity.data ->> 'turn_ref' = 'turn-1'
         and activity.data ->> 'item_ref' = 'message-1'
         and activity.data ->> 'phase' = 'delta'`,
      [taskId],
    );
    expect(streamedContent.rows[0].content).toBe("Hello world\n  ");
    const streamControlAfter = await database.query<{
      idempotency_count: number;
      event_count: number;
    }>(
      `select
         (select count(*)::int from public.idempotency_records
          where operation = 'report_session_activity') as idempotency_count,
         (select count(*)::int from public.task_events
          where task_id = $1::uuid and type = 'session_activity_reported') as event_count`,
      [taskId],
    );
    expect(streamControlAfter.rows[0]).toEqual(streamControlBefore.rows[0]);
    const completedData = {
      protocol: "codex-app-server/v1",
      phase: "completed",
      turn_ref: "turn-1",
      item_ref: "message-1",
    };
    const assistant = await report(
      "assistant_message",
      "  修复已经完成  ",
      "codex:item:message-1:completed",
      completedData,
    );
    expect(assistant.rows[0].response).toMatchObject({
      activity: { kind: "assistant_message" },
      message: { content: "修复已经完成" },
    });
    const replay = await report(
      "assistant_message",
      "  修复已经完成  ",
      "codex:item:message-1:completed",
      completedData,
    );
    expect(replay.rows[0].response).toEqual(assistant.rows[0].response);
    await expect(
      report(
        "assistant_message",
        "冲突的回复",
        "codex:item:message-1:completed",
        completedData,
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const legacyAssistant = await report(
      "assistant_message",
      "  兼容旧版完整回复  ",
      "codex:item:legacy-message",
    );
    expect(legacyAssistant.rows[0].response).toMatchObject({
      activity: { kind: "assistant_message" },
      message: { content: "兼容旧版完整回复" },
    });

    await database.query(
      `update public.tasks
       set status = 'completed', completed_at = now(),
           claimed_by_session_id = null, claim_token_hash = null,
           claimed_at = null, lease_expires_at = null
       where id = $1::uuid`,
      [taskId],
    );
    await database.query(
      `update public.ai_sessions
       set current_task_id = null, status = 'online'
       where id = $1::uuid`,
      [assignmentSessionId],
    );
    const endedClaimReplay = await report(
      "assistant_message",
      "  修复已经完成  ",
      "codex:item:message-1:completed",
      completedData,
    );
    expect(endedClaimReplay.rows[0].response).toMatchObject({
      activity: assistant.rows[0].response.activity,
      message: assistant.rows[0].response.message,
      task: { id: taskId, status: "completed" },
    });

    const counts = await database.query<{ activities: number; messages: number }>(
      `select
         (select count(*)::integer from public.session_activities where task_id = $1::uuid) as activities,
         (select count(*)::integer from public.task_messages where task_id = $1::uuid and sender_type = 'ai') as messages`,
      [taskId],
    );
    expect(counts.rows[0]).toEqual({ activities: 8, messages: 2 });
    await expect(
      database.query(
        `update public.session_activities
         set content = 'tampered'
         where task_id = $1::uuid`,
        [taskId],
      ),
    ).rejects.toThrow("SESSION_ACTIVITY_IMMUTABLE");
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

  it("derives paused aggregates from paused leaves and keeps blocked precedence", async () => {
    // Every active child paused -> the parent surfaces paused (not blocked).
    const pausedParentId = await createTask(null, "Paused parent");
    const pausedLeafAId = await createTask(pausedParentId, "Paused leaf A");
    const pausedLeafBId = await createTask(pausedParentId, "Paused leaf B");
    await setLeafStatus(pausedParentId, pausedLeafAId, "paused");
    expect((await taskState(pausedParentId)).status).toBe("ready");
    await setLeafStatus(pausedParentId, pausedLeafBId, "paused");
    expect((await taskState(pausedParentId)).status).toBe("paused");

    // A blocked sibling still outranks paused children.
    const mixedParentId = await createTask(null, "Blocked and paused parent");
    const mixedBlockedLeafId = await createTask(mixedParentId, "Blocked leaf");
    const mixedPausedLeafId = await createTask(mixedParentId, "Paused leaf");
    await setLeafStatus(mixedParentId, mixedBlockedLeafId, "blocked");
    await setLeafStatus(mixedParentId, mixedPausedLeafId, "paused");
    expect((await taskState(mixedParentId)).status).toBe("blocked");

    // Moving one leaf out of paused re-derives the parent from the new mix.
    await setLeafStatus(pausedParentId, pausedLeafAId, "blocked");
    expect((await taskState(pausedParentId)).status).toBe("blocked");
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

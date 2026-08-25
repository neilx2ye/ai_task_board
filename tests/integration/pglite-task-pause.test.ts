import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type TaskPayload = {
  id: string;
  status: string;
};

type TaskCommandResponse = {
  task: TaskPayload;
};

type SessionFixture = {
  connectionId: string;
  sessionId: string;
  tokenHash: string;
};

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");

describe("task pause/resume RPCs", () => {
  let database: PGlite;
  let workspaceId: string;
  const userId = randomUUID();
  let idempotencyCounter = 0;

  const nextIdempotency = (operation: string) => {
    idempotencyCounter += 1;
    return {
      key: `pglite/${operation}/${idempotencyCounter}`,
      requestHash: `${operation}:${idempotencyCounter}`.padEnd(64, "0"),
    };
  };

  const createSessionFixture = async (
    label: string,
  ): Promise<SessionFixture> => {
    const connectionId = randomUUID();
    const sessionId = randomUUID();
    const tokenHash = randomUUID().repeat(2);
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash,
         created_by_user_id, bridge_version, last_seen_at
       ) values (
         $1::uuid, $2::uuid, $3::text, 'Codex', $4::text,
         $5::uuid, '1.0.0', now()
       )`,
      [connectionId, workspaceId, `${label} connection`, tokenHash, userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform,
         external_conversation_ref, capabilities, status, last_seen_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::text, 'codex',
         $5::text, '{}'::text[], 'online', now()
       )`,
      [
        sessionId,
        workspaceId,
        connectionId,
        `${label} session`,
        `${label}-thread`,
      ],
    );
    return { connectionId, sessionId, tokenHash };
  };

  const createTask = async (
    title: string,
    sessionId: string,
    parentTaskId: string | null = null,
  ) => {
    const idempotency = nextIdempotency("create-task");
    const result = await database.query<{ response: TaskCommandResponse }>(
      `select public.create_user_task(
         $1::uuid, $2::uuid, $3::uuid, $4::text,
         null, null, 0, null, $5::uuid, '{}'::text[], $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        userId,
        parentTaskId,
        title,
        sessionId,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return result.rows[0].response.task.id;
  };

  const pauseTask = async (
    fixtureTaskId: string,
    operation: string,
    reason: string | null = null,
    idempotency = nextIdempotency(operation),
  ) => {
    const result = await database.query<{ response: TaskCommandResponse }>(
      `select public.pause_task(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        userId,
        fixtureTaskId,
        reason,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return result.rows[0].response;
  };

  const resumeTask = async (
    fixtureTaskId: string,
    operation: string,
    idempotency = nextIdempotency(operation),
  ) => {
    const result = await database.query<{ response: TaskCommandResponse }>(
      `select public.resume_task(
         $1::uuid, $2::uuid, $3::uuid, null, $4::text, $5::text
       ) as response`,
      [
        workspaceId,
        userId,
        fixtureTaskId,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return result.rows[0].response;
  };

  const claimTask = async (fixture: SessionFixture, fixtureTaskId: string) => {
    const claimTokenHash = randomUUID().repeat(2);
    const idempotency = nextIdempotency("claim-task");
    await database.query(
      `select public.claim_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
         $6::text, 900, $7::text, $8::text
       )`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        fixture.sessionId,
        fixtureTaskId,
        claimTokenHash,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return claimTokenHash;
  };

  const claimNextTaskId = async (fixture: SessionFixture) => {
    const idempotency = nextIdempotency("claim-next");
    const result = await database.query<{
      response: { task: { id: string } | null };
    }>(
      `select public.claim_next_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         900, $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        fixture.connectionId,
        fixture.tokenHash,
        fixture.sessionId,
        randomUUID().repeat(2),
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return result.rows[0].response.task?.id ?? null;
  };

  const taskRow = async (fixtureTaskId: string) => {
    const result = await database.query<{
      status: string;
      assigned_session_id: string | null;
      claimed_by_session_id: string | null;
      claim_token_hash: string | null;
      claimed_at: string | null;
      lease_expires_at: string | null;
    }>(
      `select status::text, assigned_session_id, claimed_by_session_id,
              claim_token_hash, claimed_at::text, lease_expires_at::text
       from public.tasks
       where id = $1::uuid`,
      [fixtureTaskId],
    );
    return result.rows[0];
  };

  const eventRows = async (fixtureTaskId: string, type: string) => {
    const result = await database.query<{
      actor_type: string;
      actor_id: string | null;
      data: Record<string, string>;
    }>(
      `select actor_type::text, actor_id, data
       from public.task_events
       where task_id = $1::uuid and type = $2::text
       order by id`,
      [fixtureTaskId, type],
    );
    return result.rows;
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

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const migrationName of migrationFiles) {
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
      [userId, `task-pause-${userId}@example.invalid`],
    );
    const membership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [userId],
    );
    workspaceId = membership.rows[0].workspace_id;
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  it("pauses and resumes a ready leaf and replays the pause idempotently", async () => {
    const fixture = await createSessionFixture("Ready leaf");
    const taskId = await createTask("Pausable ready leaf", fixture.sessionId);

    const idempotency = nextIdempotency("pause-ready-leaf");
    const pause = await pauseTask(taskId, "pause-ready-leaf", null, idempotency);
    expect(pause.task.status).toBe("paused");
    expect(await taskRow(taskId)).toMatchObject({
      status: "paused",
      assigned_session_id: fixture.sessionId,
      claimed_by_session_id: null,
    });

    // A ready leaf had no claim, so pausing enqueues no interrupt command.
    const commands = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.ai_thread_commands
       where workspace_id = $1::uuid`,
      [workspaceId],
    );
    expect(commands.rows[0].count).toBe(0);

    // The paused task leaves the claim pool.
    expect(await claimNextTaskId(fixture)).toBeNull();

    // Replaying the same idempotency key returns the cached response and
    // writes no second event.
    const replay = await pauseTask(taskId, "pause-ready-leaf", null, idempotency);
    expect(replay).toEqual(pause);
    const pausedEvents = await eventRows(taskId, "task_paused");
    expect(pausedEvents).toHaveLength(1);
    expect(pausedEvents[0]).toMatchObject({
      actor_type: "user",
      actor_id: userId,
      data: { from: "ready" },
    });

    const resume = await resumeTask(taskId, "resume-ready-leaf");
    expect(resume.task.status).toBe("ready");
    const resumedEvents = await eventRows(taskId, "task_resumed");
    expect(resumedEvents).toEqual([
      { actor_type: "user", actor_id: userId, data: { to: "ready" } },
    ]);

    // The resumed task goes back to the same session's claim pool.
    expect(await claimNextTaskId(fixture)).toBe(taskId);
  });

  it("pausing a claimed leaf clears the claim and enqueues a pinned interrupt command", async () => {
    const fixture = await createSessionFixture("Claimed leaf");
    const taskId = await createTask("Pausable claimed leaf", fixture.sessionId);
    await claimTask(fixture, taskId);
    expect(await taskRow(taskId)).toMatchObject({
      status: "claimed",
      claimed_by_session_id: fixture.sessionId,
    });

    const idempotency = nextIdempotency("pause-claimed-leaf");
    const pause = await pauseTask(
      taskId,
      "pause-claimed-leaf",
      "Operator pause",
      idempotency,
    );
    expect(pause.task.status).toBe("paused");
    expect(await taskRow(taskId)).toMatchObject({
      status: "paused",
      assigned_session_id: fixture.sessionId,
      claimed_by_session_id: null,
      claim_token_hash: null,
      claimed_at: null,
      lease_expires_at: null,
    });

    // The session's current task pointer is freed.
    const session = await database.query<{
      current_task_id: string | null;
    }>(
      "select current_task_id from public.ai_sessions where id = $1::uuid",
      [fixture.sessionId],
    );
    expect(session.rows[0].current_task_id).toBeNull();

    // The interrupt command is pinned to the paused task so a Bridge that
    // already moved on to the session's next task treats it as a no-op.
    const commands = await database.query<{
      connection_id: string;
      session_id: string | null;
      action: string;
      name: string | null;
      task_id: string | null;
      external_thread_id: string | null;
      platform: string;
      status: string;
    }>(
      `select connection_id, session_id, action, name, task_id,
              external_thread_id, platform, status::text
       from public.ai_thread_commands
       where workspace_id = $1::uuid`,
      [workspaceId],
    );
    expect(commands.rows).toEqual([
      {
        connection_id: fixture.connectionId,
        session_id: fixture.sessionId,
        action: "pause",
        name: null,
        task_id: taskId,
        external_thread_id: "Claimed leaf-thread",
        platform: "codex",
        status: "queued",
      },
    ]);

    const pausedEvents = await eventRows(taskId, "task_paused");
    expect(pausedEvents).toEqual([
      {
        actor_type: "user",
        actor_id: userId,
        data: { from: "claimed", reason: "Operator pause" },
      },
    ]);

    // Idempotent replay: cached response, no second command or event.
    const replay = await pauseTask(
      taskId,
      "pause-claimed-leaf",
      "Operator pause",
      idempotency,
    );
    expect(replay).toEqual(pause);
    const commandCount = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.ai_thread_commands
       where workspace_id = $1::uuid`,
      [workspaceId],
    );
    expect(commandCount.rows[0].count).toBe(1);
    expect(await eventRows(taskId, "task_paused")).toHaveLength(1);
  });

  it("rejects invalid pause/resume transitions and re-blocks dependents on resume", async () => {
    const fixture = await createSessionFixture("Guarded");
    const waitingTaskId = await createTask(
      "Waiting leaf cannot pause",
      fixture.sessionId,
    );
    await database.query(
      `update public.tasks
       set status = 'waiting_user'
       where id = $1::uuid`,
      [waitingTaskId],
    );

    // waiting_user is handed back to the user; there is no turn to pause.
    const waitingIdempotency = nextIdempotency("pause-waiting-leaf");
    await expect(
      database.query(
        `select public.pause_task(
           $1::uuid, $2::uuid, $3::uuid, null, $4::text, $5::text
         )`,
        [
          workspaceId,
          userId,
          waitingTaskId,
          waitingIdempotency.key,
          waitingIdempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("INVALID_STATE_TRANSITION");

    // Aggregate parents derive their status from descendants.
    const parentTaskId = await createTask(
      "Aggregate parent cannot pause",
      fixture.sessionId,
    );
    await createTask("Aggregate child", fixture.sessionId, parentTaskId);
    const parentIdempotency = nextIdempotency("pause-aggregate-parent");
    await expect(
      database.query(
        `select public.pause_task(
           $1::uuid, $2::uuid, $3::uuid, null, $4::text, $5::text
         )`,
        [
          workspaceId,
          userId,
          parentTaskId,
          parentIdempotency.key,
          parentIdempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("INVALID_STATE_TRANSITION");

    // Resume only applies to paused tasks.
    const resumeIdempotency = nextIdempotency("resume-waiting-leaf");
    await expect(
      database.query(
        `select public.resume_task(
           $1::uuid, $2::uuid, $3::uuid, null, $4::text, $5::text
         )`,
        [
          workspaceId,
          userId,
          waitingTaskId,
          resumeIdempotency.key,
          resumeIdempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("INVALID_STATE_TRANSITION");

    // Resume re-checks dependencies: an unfinished prerequisite blocks it.
    const blockerTaskId = await createTask(
      "Unfinished prerequisite",
      fixture.sessionId,
    );
    const dependentTaskId = await createTask(
      "Paused with unfinished dependency",
      fixture.sessionId,
    );
    const pauseDependent = await pauseTask(dependentTaskId, "pause-dependent");
    expect(pauseDependent.task.status).toBe("paused");
    await database.query(
      `insert into public.task_dependencies (task_id, depends_on_task_id)
       values ($1::uuid, $2::uuid)`,
      [dependentTaskId, blockerTaskId],
    );
    const resumeDependent = await resumeTask(dependentTaskId, "resume-blocked");
    expect(resumeDependent.task.status).toBe("blocked");
    expect(await taskRow(dependentTaskId)).toMatchObject({
      status: "blocked",
      assigned_session_id: fixture.sessionId,
    });
    const resumedEvents = await eventRows(dependentTaskId, "task_resumed");
    expect(resumedEvents).toEqual([
      { actor_type: "user", actor_id: userId, data: { to: "blocked" } },
    ]);
  });
});

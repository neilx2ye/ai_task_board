import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");
const migrations = [
  "20260808000000_initial_schema.sql",
  "20260808000100_core_functions.sql",
  "20260808000200_rls_storage.sql",
  "20260808000300_session_directed_dispatch.sql",
  "20260809141451_session_conversation_bridge.sql",
  "20260809141643_session_activity_fk_indexes.sql",
  "20260809150155_heartbeat_idempotency_maintenance.sql",
  "20260810100000_bridge_v2_thread_inventory.sql",
  "20260810130000_bridge_remote_configuration.sql",
  "20260810170000_codex_history_sync.sql",
  "20260810180000_web_thread_management.sql",
  "20260811120000_structured_user_input.sql",
];

describe("structured Web user input migration", () => {
  let database: PGlite;
  const userId = randomUUID();
  const connectionId = randomUUID();
  const sessionId = randomUUID();
  const taskId = randomUUID();
  const requestId = randomUUID();
  const tokenHash = randomUUID().repeat(2);
  const claimHash = randomUUID().repeat(2);
  let workspaceId: string;

  const questions = [
    {
      id: "deployment",
      header: "发布方式",
      question: "请选择发布策略",
      options: [
        { label: "滚动发布", description: "逐实例替换" },
        { label: "立即切换", description: "一次切换全部流量" },
      ],
      isOther: false,
      isSecret: false,
    },
    {
      id: "note",
      header: "备注",
      question: "请输入发布备注",
      options: null,
      isOther: false,
      isSecret: true,
    },
  ];

  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create schema extensions;
      create function extensions.gen_random_uuid()
      returns uuid language sql volatile
      as $$ select pg_catalog.gen_random_uuid() $$;
      create schema auth;
      create table auth.users (
        id uuid primary key,
        email text,
        raw_user_meta_data jsonb not null default '{}'::jsonb
      );
      create function auth.uid()
      returns uuid language sql stable as $$ select null::uuid $$;
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
    for (const migrationName of migrations) {
      const migration = await readFile(
        path.join(migrationsDirectory, migrationName),
        "utf8",
      );
      await database.exec(
        migration.replace(
          "create extension if not exists pgcrypto with schema extensions;",
          "",
        ),
      );
    }

    await database.query(
      "insert into auth.users (id, email) values ($1::uuid, $2::text)",
      [userId, `structured-${userId}@example.invalid`],
    );
    const membership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [userId],
    );
    workspaceId = membership.rows[0].workspace_id;
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash,
         created_by_user_id, bridge_version, last_seen_at
       ) values (
         $1::uuid, $2::uuid, 'Structured Bridge', 'codex', $3::text,
         $4::uuid, '0.6.0', now()
       )`,
      [connectionId, workspaceId, tokenHash, userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform,
         external_conversation_ref, capabilities, status
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'Structured Thread', 'codex',
         'structured-thread', '{}'::text[], 'online'
       )`,
      [sessionId, workspaceId, connectionId],
    );
    await database.exec("begin");
    try {
      await database.query(
        `insert into public.tasks (
           id, workspace_id, root_task_id, title, status,
           assigned_session_id, claimed_by_session_id, claim_token_hash,
           claimed_at, lease_expires_at, created_by_type, created_by_id
         ) values (
           $1::uuid, $2::uuid, $1::uuid, 'Wait in the same turn', 'running',
           $3::uuid, $3::uuid, $4::text, now(), now() + interval '15 minutes',
           'user', $5::uuid
         )`,
        [taskId, workspaceId, sessionId, claimHash, userId],
      );
      await database.query(
        `update public.ai_sessions
         set status = 'busy', current_task_id = $2::uuid
         where id = $1::uuid`,
        [sessionId, taskId],
      );
      await database.exec("commit");
    } catch (error) {
      await database.exec("rollback");
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("retains the claim, accepts Web answers, and clears secrets on completion", async () => {
    const registered = await database.query<{
      response: { request: { id: string; status: string } };
    }>(
      `select public.register_task_user_input_request(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text,
         $7::uuid, 'app-request-7', 'turn-1', 'item-1', true,
         $8::jsonb, 'register-1', $9::text
       ) as response`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        sessionId,
        taskId,
        claimHash,
        requestId,
        JSON.stringify(questions),
        "register-structured-request-hash".padEnd(64, "0"),
      ],
    );
    expect(registered.rows[0].response.request).toMatchObject({
      id: requestId,
      status: "pending",
    });

    const waiting = await database.query<{
      status: string;
      awaiting_user_input: boolean;
      claimed_by_session_id: string | null;
      claim_token_hash: string | null;
      current_task_id: string | null;
      session_status: string;
    }>(
      `select task.status, task.awaiting_user_input,
              task.claimed_by_session_id::text, task.claim_token_hash,
              session.current_task_id::text,
              session.status::text as session_status
       from public.tasks task
       join public.ai_sessions session on session.id = $2::uuid
       where task.id = $1::uuid`,
      [taskId, sessionId],
    );
    expect(waiting.rows[0]).toMatchObject({
      status: "running",
      awaiting_user_input: true,
      claimed_by_session_id: sessionId,
      claim_token_hash: claimHash,
      current_task_id: taskId,
      session_status: "waiting",
    });

    await database.query(
      "update public.ai_sessions set status = 'busy' where id = $1::uuid",
      [sessionId],
    );
    const preservedWaiting = await database.query<{ status: string }>(
      "select status::text from public.ai_sessions where id = $1::uuid",
      [sessionId],
    );
    expect(preservedWaiting.rows[0].status).toBe("waiting");

    const pendingPoll = await database.query<{
      response: { request: { status: string; answers: null } };
    }>(
      `select public.poll_task_user_input_request(
         $1::uuid, $2::uuid, $3::text, $4::uuid,
         $5::uuid, $6::text, $7::uuid
       ) as response`,
      [workspaceId, connectionId, tokenHash, sessionId, taskId, claimHash, requestId],
    );
    expect(pendingPoll.rows[0].response.request).toEqual({
      id: requestId,
      status: "pending",
      answers: null,
    });

    await expect(
      database.query(
        `select public.answer_task_user_input_request(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb,
           'answer-invalid', $6::text
         )`,
        [
          workspaceId,
          userId,
          taskId,
          requestId,
          JSON.stringify({ deployment: ["未知策略"], note: ["secret"] }),
          "invalid-answer-request-hash".padEnd(64, "0"),
        ],
      ),
    ).rejects.toThrow(/INVALID_REQUEST/);

    const answers = {
      deployment: ["滚动发布"],
      note: ["internal release note"],
    };
    await database.query(
      `select public.answer_task_user_input_request(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb,
         'answer-valid', $6::text
       )`,
      [
        workspaceId,
        userId,
        taskId,
        requestId,
        JSON.stringify(answers),
        "valid-answer-request-hash".padEnd(64, "0"),
      ],
    );

    const answeredPoll = await database.query<{
      response: { request: { status: string; answers: typeof answers } };
    }>(
      `select public.poll_task_user_input_request(
         $1::uuid, $2::uuid, $3::text, $4::uuid,
         $5::uuid, $6::text, $7::uuid
       ) as response`,
      [workspaceId, connectionId, tokenHash, sessionId, taskId, claimHash, requestId],
    );
    expect(answeredPoll.rows[0].response.request).toMatchObject({
      status: "answered",
      answers,
    });

    const resumed = await database.query<{
      awaiting_user_input: boolean;
      status: string;
      claim_token_hash: string | null;
    }>(
      `select awaiting_user_input, status::text, claim_token_hash
       from public.tasks where id = $1::uuid`,
      [taskId],
    );
    expect(resumed.rows[0]).toEqual({
      awaiting_user_input: false,
      status: "running",
      claim_token_hash: claimHash,
    });

    const messages = await database.query<{ content: string }>(
      `select content from public.task_messages
       where task_id = $1::uuid and sender_type = 'user'`,
      [taskId],
    );
    expect(messages.rows.map((message) => message.content).join("\n"))
      .not.toContain("internal release note");

    await database.query(
      `update public.tasks
       set status = 'completed', completed_at = now(),
           claimed_by_session_id = null, claim_token_hash = null,
           claimed_at = null, lease_expires_at = null
       where id = $1::uuid`,
      [taskId],
    );
    const cleaned = await database.query<{
      status: string;
      answers: unknown;
    }>(
      `select status, answers
       from public.task_user_input_requests where id = $1::uuid`,
      [requestId],
    );
    expect(cleaned.rows[0]).toEqual({ status: "consumed", answers: null });
  });
});

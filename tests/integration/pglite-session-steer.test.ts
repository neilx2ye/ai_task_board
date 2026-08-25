import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");

/**
 * Session Steer 模式：create_session_turn_with_settings 的 13 参数重载把
 * steer 写入任务；claim_steer_task 只领取 steer 任务且不触碰主 turn 的
 * Session 归属。全量应用 migrations，保证与 Hosted 结构一致。
 */
describe("session steer mode migration", () => {
  let database: PGlite;
  let workspaceId: string;
  const userId = randomUUID();
  const connectionId = randomUUID();
  const sessionId = randomUUID();
  const tokenHash = randomUUID().repeat(2);
  let idempotencyCounter = 0;

  const nextIdempotency = (operation: string) => {
    idempotencyCounter += 1;
    return {
      key: `pglite/${operation}/${idempotencyCounter}`,
      requestHash: `${operation}:${idempotencyCounter}`.padEnd(64, "0"),
    };
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
      await database.exec(
        migration.replace(
          "create extension if not exists pgcrypto with schema extensions;",
          "",
        ),
      );
    }

    await database.query(
      "insert into auth.users (id, email) values ($1::uuid, $2::text)",
      [userId, `session-steer-${userId}@example.invalid`],
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
         $1::uuid, $2::uuid, 'Codex device', 'Codex', $3::text,
         $4::uuid, '1.8.7', now()
       )`,
      [connectionId, workspaceId, tokenHash, userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform,
         external_conversation_ref, capabilities, status, last_seen_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'Steer 线程', 'codex',
         'local-thread-steer', '{}'::text[], 'online', now()
       )`,
      [sessionId, workspaceId, connectionId],
    );
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  const insertMainTask = async (): Promise<string> => {
    const taskId = randomUUID();
    await database.query(
      `insert into public.tasks (
         id, workspace_id, root_task_id, title, description, status,
         priority, assigned_session_id, steer, created_by_type
       ) values (
         $1::uuid, $2::uuid, $1::uuid, '主任务', '运行中的 turn', 'ready',
         50, $3::uuid, false, 'user'
       )`,
      [taskId, workspaceId, sessionId],
    );
    return taskId;
  };

  const createSteerTurn = async (content: string) => {
    const idempotency = nextIdempotency("create-steer-turn");
    const result = await database.query<{
      response: { task: { id: string; steer: boolean } };
    }>(
      `select public.create_session_turn_with_settings(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
         50, '[]'::jsonb, null, null, null, true, $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        userId,
        sessionId,
        content.slice(0, 80),
        content,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return result.rows[0].response.task;
  };

  const claimMainTask = async () => {
    const claimTokenHash = randomUUID().repeat(2);
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
        connectionId,
        tokenHash,
        sessionId,
        claimTokenHash,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    const taskId = result.rows[0].response.task?.id ?? null;
    if (!taskId) throw new Error("claim_next_task 未返回主任务");
    return { taskId, claimTokenHash };
  };

  const claimSteerTask = async () => {
    const claimTokenHash = randomUUID().repeat(2);
    const idempotency = nextIdempotency("claim-steer");
    const result = await database.query<{
      response: { task: { id: string; steer: boolean } | null };
    }>(
      `select public.claim_steer_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         900, $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        sessionId,
        claimTokenHash,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    const taskId = result.rows[0].response.task?.id ?? null;
    return { taskId, claimTokenHash };
  };

  const sessionCurrentTask = async () => {
    const result = await database.query<{
      current_task_id: string | null;
      status: string;
    }>(
      "select current_task_id, status::text from public.ai_sessions where id = $1::uuid",
      [sessionId],
    );
    return result.rows[0];
  };

  const taskStatus = async (taskId: string) => {
    const result = await database.query<{ status: string }>(
      "select status::text from public.tasks where id = $1::uuid",
      [taskId],
    );
    return result.rows[0].status;
  };

  it("stores the steer flag and claims it only while a main turn is active", async () => {
    const mainTaskId = await insertMainTask();
    const steerTask = await createSteerTurn("把输出改成表格");
    expect(steerTask.steer).toBe(true);

    // Thread 空闲：steer 领取必须为空轮询。
    expect((await claimSteerTask()).taskId).toBeNull();

    // 主 turn 开始后，steer 领取返回 steer 任务，且不动 Session 归属。
    const main = await claimMainTask();
    expect(main.taskId).toBe(mainTaskId);
    expect(await sessionCurrentTask()).toMatchObject({
      current_task_id: mainTaskId,
      status: "busy",
    });

    const steer = await claimSteerTask();
    expect(steer.taskId).toBe(steerTask.id);
    expect(await taskStatus(steerTask.id)).toBe("claimed");
    expect(await sessionCurrentTask()).toMatchObject({
      current_task_id: mainTaskId,
      status: "busy",
    });

    // 完成 steer 辅助任务后，主 turn 的 Session 归属保持不变。
    const completionIdempotency = nextIdempotency("complete-steer");
    await database.query(
      `select public.complete_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text,
         '已实时调整正在运行的 Turn', null, null, '[]'::jsonb,
         $7::text, $8::text
       )`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        sessionId,
        steerTask.id,
        steer.claimTokenHash,
        completionIdempotency.key,
        completionIdempotency.requestHash,
      ],
    );
    expect(await taskStatus(steerTask.id)).toBe("completed");
    expect(await sessionCurrentTask()).toMatchObject({
      current_task_id: mainTaskId,
      status: "busy",
    });

    // 队列清空后继续空轮询。
    expect((await claimSteerTask()).taskId).toBeNull();
  });
});

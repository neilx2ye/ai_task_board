import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");

type DispatchResponse = {
  dispatched: { step_id: string; task_id: string }[];
};

type PlanRow = {
  id: string;
  status: string;
  dispatched_task_id: string | null;
};

/**
 * 规划工作台的 Turn 链：dispatch_session_turn_chain 把草稿步骤变成
 * 依赖链任务，前一个完成后 _refresh_unblocked_tasks 自动放行下一个。
 * 全量应用 supabase/migrations 下的所有迁移，保证与 Hosted 结构一致。
 */
describe("turn plan chain dispatch migration", () => {
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
      [userId, `turn-plan-${userId}@example.invalid`],
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
         $4::uuid, '1.0.0', now()
       )`,
      [connectionId, workspaceId, tokenHash, userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform,
         external_conversation_ref, capabilities, status, last_seen_at
       ) values (
         $1::uuid, $2::uuid, $3::uuid, '规划线程', 'codex',
         'local-thread-plan', '{}'::text[], 'online', now()
       )`,
      [sessionId, workspaceId, connectionId],
    );
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  const addStep = async (content: string, position: number) => {
    const id = randomUUID();
    await database.query(
      `insert into public.session_turn_plans (
         id, workspace_id, session_id, position, content, created_by
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, $6::uuid
       )`,
      [id, workspaceId, sessionId, position, content, userId],
    );
    return id;
  };

  const dispatch = async (operation: string) => {
    const idempotency = nextIdempotency(operation);
    const result = await database.query<{ response: DispatchResponse }>(
      `select public.dispatch_session_turn_chain(
         $1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, $4::text, $5::text
       ) as response`,
      [
        workspaceId,
        userId,
        sessionId,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    return {
      idempotency,
      response: result.rows[0].response,
    };
  };

  const taskStatus = async (taskId: string) => {
    const result = await database.query<{ status: string }>(
      "select status::text from public.tasks where id = $1::uuid",
      [taskId],
    );
    return result.rows[0].status;
  };

  const taskDependencies = async (taskId: string) => {
    const result = await database.query<{ depends_on_task_id: string }>(
      "select depends_on_task_id from public.task_dependencies where task_id = $1::uuid",
      [taskId],
    );
    return result.rows.map((row) => row.depends_on_task_id);
  };

  const planRow = async (stepId: string) => {
    const result = await database.query<PlanRow>(
      `select id, status::text, dispatched_task_id
       from public.session_turn_plans where id = $1::uuid`,
      [stepId],
    );
    return result.rows[0];
  };

  const claimNext = async () => {
    const claimTokenHash = randomUUID().repeat(2);
    const idempotency = nextIdempotency("claim-next");
    const result = await database.query<{
      response: { task: { id: string } | null };
    }>(
      `select public.claim_next_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
         $6::integer, $7::text, $8::text
       ) as response`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        sessionId,
        claimTokenHash,
        900,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    const taskId = result.rows[0].response.task?.id ?? null;
    return { taskId, claimTokenHash };
  };

  const completeTask = async (taskId: string, claimTokenHash: string) => {
    const idempotency = nextIdempotency("complete-task");
    await database.query(
      `select public.complete_task(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text,
         'done', null, null, '[]'::jsonb, $7::text, $8::text
       )`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        sessionId,
        taskId,
        claimTokenHash,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
  };

  it("把草稿步骤派发成依赖链：首步 ready，其余 blocked", async () => {
    const stepA = await addStep("第一步：调研现状", 1024);
    const stepB = await addStep("第二步：实现方案", 2048);
    const stepC = await addStep("第三步：补充测试", 3072);

    const { idempotency, response } = await dispatch("dispatch-chain-1");
    expect(response.dispatched.map((entry) => entry.step_id)).toEqual([
      stepA,
      stepB,
      stepC,
    ]);

    const [taskA, taskB, taskC] = response.dispatched.map(
      (entry) => entry.task_id,
    );
    expect(await taskStatus(taskA)).toBe("ready");
    expect(await taskStatus(taskB)).toBe("blocked");
    expect(await taskStatus(taskC)).toBe("blocked");
    expect(await taskDependencies(taskA)).toEqual([]);
    expect(await taskDependencies(taskB)).toEqual([taskA]);
    expect(await taskDependencies(taskC)).toEqual([taskB]);

    // 三个步骤都应是该会话的会话 Turn 任务（含对话消息）。
    const messages = await database.query<{ count: string }>(
      `select count(*)::text from public.task_messages
       where workspace_id = $1::uuid and task_id = any($2::uuid[])`,
      [workspaceId, [taskA, taskB, taskC]],
    );
    expect(messages.rows[0].count).toBe("3");

    for (const [stepId, taskId] of [
      [stepA, taskA],
      [stepB, taskB],
      [stepC, taskC],
    ] as const) {
      const plan = await planRow(stepId);
      expect(plan.status).toBe("dispatched");
      expect(plan.dispatched_task_id).toBe(taskId);
    }

    // 相同幂等键重放返回缓存响应，不会重复创建任务。
    const replayed = await database.query<{ response: DispatchResponse }>(
      `select public.dispatch_session_turn_chain(
         $1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, $4::text, $5::text
       ) as response`,
      [
        workspaceId,
        userId,
        sessionId,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
    expect(replayed.rows[0].response).toEqual(response);
    const turns = await database.query<{ count: string }>(
      `select count(*)::text from public.tasks
       where workspace_id = $1::uuid and assigned_session_id = $2::uuid`,
      [workspaceId, sessionId],
    );
    expect(turns.rows[0].count).toBe("3");
  });

  it("前一个 Turn 完成后下一个自动变为 ready 并可被领取", async () => {
    const first = await claimNext();
    expect(first.taskId).not.toBeNull();
    await completeTask(first.taskId!, first.claimTokenHash);

    const plans = await database.query<PlanRow>(
      `select id, status::text, dispatched_task_id
       from public.session_turn_plans
       where workspace_id = $1::uuid and session_id = $2::uuid
       order by position`,
      [workspaceId, sessionId],
    );
    const [, second, third] = plans.rows;
    expect(await taskStatus(second.dispatched_task_id!)).toBe("ready");
    expect(await taskStatus(third.dispatched_task_id!)).toBe("blocked");

    const next = await claimNext();
    expect(next.taskId).toBe(second.dispatched_task_id);
  });

  it("链执行中追加草稿会挂到链尾", async () => {
    const stepD = await addStep("第四步：整理文档", 4096);
    const { response } = await dispatch("dispatch-chain-2");
    expect(response.dispatched.map((entry) => entry.step_id)).toEqual([
      stepD,
    ]);
    const taskD = response.dispatched[0].task_id;

    // 链尾是仍未完成的第三步任务。
    const plans = await database.query<PlanRow>(
      `select id, status::text, dispatched_task_id
       from public.session_turn_plans
       where workspace_id = $1::uuid and session_id = $2::uuid
       order by position`,
      [workspaceId, sessionId],
    );
    const third = plans.rows[2];
    expect(await taskDependencies(taskD)).toEqual([
      third.dispatched_task_id,
    ]);
    expect(await taskStatus(taskD)).toBe("blocked");
  });

  it("没有草稿步骤时拒绝派发", async () => {
    const idempotency = nextIdempotency("dispatch-empty");
    await expect(
      database.query(
        `select public.dispatch_session_turn_chain(
           $1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, $4::text, $5::text
         )`,
        [
          workspaceId,
          userId,
          sessionId,
          idempotency.key,
          idempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("INVALID_TASK");
  });

  it("会话离线时拒绝派发", async () => {
    const stepId = await addStep("离线时的步骤", 5120);
    await database.query(
      `update public.ai_sessions
       set status = 'offline', last_seen_at = now() - interval '10 minutes'
       where id = $1::uuid`,
      [sessionId],
    );
    const idempotency = nextIdempotency("dispatch-offline");
    await expect(
      database.query(
        `select public.dispatch_session_turn_chain(
           $1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, $4::text, $5::text
         )`,
        [
          workspaceId,
          userId,
          sessionId,
          idempotency.key,
          idempotency.requestHash,
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    // 失败的派发保持草稿状态，会话恢复后仍可派发。
    const plan = await planRow(stepId);
    expect(plan.status).toBe("draft");
  });
});

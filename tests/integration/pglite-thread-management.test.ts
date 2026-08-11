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
];

type CommandResponse = {
  command: null | {
    id: string;
    action: "create" | "rename" | "delete";
    name: string | null;
    external_thread_id: string | null;
    status: "queued" | "running" | "succeeded" | "failed";
  };
};

describe("Web Thread management migration", () => {
  let database: PGlite;
  const userId = randomUUID();
  const connectionId = randomUUID();
  const sessionId = randomUUID();
  const runtimeId = randomUUID();
  const tokenHash = randomUUID().repeat(2);
  let workspaceId: string;

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
      [userId, `thread-management-${userId}@example.invalid`],
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
         $4::uuid, '0.5.0', now()
       )`,
      [connectionId, workspaceId, tokenHash, userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform,
         external_conversation_ref, capabilities
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'Source title', 'codex',
         'local-thread-1', '{}'::text[]
       )`,
      [sessionId, workspaceId, connectionId],
    );
    await database.query(
      `update public.ai_connection_bridge_settings
       set active_runtime_instance_id = $3::uuid,
           active_runtime_last_sequence = 1,
           active_runtime_lease_expires_at = now() + interval '5 minutes'
       where workspace_id = $1::uuid and connection_id = $2::uuid`,
      [workspaceId, connectionId, runtimeId],
    );
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  const enqueue = async (input: {
    commandId: string;
    sessionId: string | null;
    action: "create" | "rename" | "delete";
    name: string | null;
    key: string;
  }) => {
    const result = await database.query<{ response: CommandResponse }>(
      `select public.enqueue_ai_thread_command(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::text, $7::text, $8::text, $9::text
       ) as response`,
      [
        workspaceId,
        userId,
        input.commandId,
        connectionId,
        input.sessionId,
        input.action,
        input.name,
        input.key,
        `${input.key}-request-hash`.padEnd(64, "0"),
      ],
    );
    return result.rows[0].response;
  };

  const claim = async () => {
    const result = await database.query<{ response: CommandResponse }>(
      `select public.claim_ai_thread_command(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 60
       ) as response`,
      [workspaceId, connectionId, tokenHash, runtimeId],
    );
    return result.rows[0].response;
  };

  const complete = async (
    commandId: string,
    succeeded: boolean,
    externalThreadId: string | null,
    error: string | null,
  ) => {
    const result = await database.query<{ response: CommandResponse }>(
      `select public.complete_ai_thread_command(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
         $6::boolean, $7::text, $8::text
       ) as response`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        runtimeId,
        commandId,
        succeeded,
        externalThreadId,
        error,
      ],
    );
    return result.rows[0].response;
  };

  it("renames an AI connection idempotently", async () => {
    const response = await database.query<{
      response: { connection: { name: string } };
    }>(
      `select public.rename_ai_connection(
         $1::uuid, $2::uuid, $3::uuid, '  Workstation  ',
         'rename-connection-1', $4::text
       ) as response`,
      [workspaceId, userId, connectionId, "rename-connection-hash".padEnd(64, "0")],
    );
    expect(response.rows[0].response.connection.name).toBe("Workstation");
  });

  it("creates a Thread command and applies its requested Web name", async () => {
    const commandId = randomUUID();
    const queued = await enqueue({
      commandId,
      sessionId: null,
      action: "create",
      name: "New Web Thread",
      key: "create-thread-1",
    });
    expect(queued.command).toMatchObject({
      id: commandId,
      action: "create",
      status: "queued",
    });

    expect((await claim()).command).toMatchObject({
      id: commandId,
      status: "running",
    });
    const createdSessionId = randomUUID();
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform,
         external_conversation_ref, capabilities
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'Bridge source name', 'codex',
         'local-created-thread', '{}'::text[]
       )`,
      [createdSessionId, workspaceId, connectionId],
    );
    expect(
      (await complete(commandId, true, "local-created-thread", null)).command,
    ).toMatchObject({ status: "succeeded" });

    const created = await database.query<{ user_name: string | null }>(
      "select user_name from public.ai_sessions where id = $1::uuid",
      [createdSessionId],
    );
    expect(created.rows[0].user_name).toBe("New Web Thread");
  });

  it("renames immediately and only deletes an idle Thread", async () => {
    const renameCommandId = randomUUID();
    await enqueue({
      commandId: renameCommandId,
      sessionId,
      action: "rename",
      name: "Renamed in Console",
      key: "rename-thread-1",
    });
    const renamed = await database.query<{ user_name: string | null }>(
      "select user_name from public.ai_sessions where id = $1::uuid",
      [sessionId],
    );
    expect(renamed.rows[0].user_name).toBe("Renamed in Console");
    expect((await claim()).command?.id).toBe(renameCommandId);
    await complete(renameCommandId, true, "local-thread-1", null);

    const taskId = randomUUID();
    await database.query(
      `insert into public.tasks (
         id, workspace_id, root_task_id, title, status,
         assigned_session_id, created_by_type, created_by_id
       ) values (
         $1::uuid, $2::uuid, $1::uuid, 'Queued work', 'ready',
         $3::uuid, 'user', $4::uuid
       )`,
      [taskId, workspaceId, sessionId, userId],
    );
    await expect(
      enqueue({
        commandId: randomUUID(),
        sessionId,
        action: "delete",
        name: null,
        key: "delete-thread-busy",
      }),
    ).rejects.toThrow(/THREAD_NOT_IDLE/);

    await database.query(
      `update public.tasks
       set status = 'completed', completed_at = now()
       where id = $1::uuid`,
      [taskId],
    );
    const deleteCommandId = randomUUID();
    await enqueue({
      commandId: deleteCommandId,
      sessionId,
      action: "delete",
      name: null,
      key: "delete-thread-idle",
    });

    const deleting = await database.query<{
      status: string;
      deletion_requested_at: string | null;
    }>(
      `select status, deletion_requested_at::text
       from public.ai_sessions where id = $1::uuid`,
      [sessionId],
    );
    expect(deleting.rows[0].status).toBe("offline");
    expect(deleting.rows[0].deletion_requested_at).not.toBeNull();
    await expect(
      database.query(
        `select public._assert_active_session(
           $1::uuid, $2::uuid, $3::text, $4::uuid
         )`,
        [workspaceId, connectionId, tokenHash, sessionId],
      ),
    ).rejects.toThrow(/SESSION_NOT_AUTHORIZED/);

    expect((await claim()).command?.id).toBe(deleteCommandId);
    expect(
      (await complete(deleteCommandId, true, "local-thread-1", null)).command,
    ).toMatchObject({ status: "succeeded" });
  });
});

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
  "20260811130000_session_process_detail_sync.sql",
  "20260811140000_bridge_working_directories.sql",
  "20260811150000_web_managed_working_directories.sql",
  "20260811160000_normalize_legacy_unassigned_tasks.sql",
  "20260812100000_bridge_full_access_default.sql",
  "20260812130000_session_turn_images.sql",
  "20260813110000_thread_model_settings.sql",
  "20260813134500_existing_thread_settings.sql",
  "20260813143000_turn_model_settings.sql",
  "20260813170000_dynamic_model_catalog.sql",
  "20260815120000_planning_workspace.sql",
  "20260815150000_turn_goal_mode.sql",
  "20260816120000_web_create_working_directories.sql",
  "20260817120000_connection_quota.sql",
  "20260818000000_bridge_device_identity.sql",
  "20260819000000_bridge_desired_version.sql",
  "20260820000000_device_file_browsing.sql",
];

type CommandResponse = {
  command: null | {
    id: string;
    action: "list" | "read";
    path: string;
    status: "queued" | "running" | "succeeded" | "failed";
    runtime_instance_id: string | null;
    result: unknown;
    error: string | null;
  };
};

describe("Device file browsing migration", () => {
  let database: PGlite;
  const userId = randomUUID();
  const connectionId = randomUUID();
  const runtimeId = randomUUID();
  const otherRuntimeId = randomUUID();
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
      [userId, `device-file-command-${userId}@example.invalid`],
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
         $1::uuid, $2::uuid, 'Device', 'Codex', $3::text,
         $4::uuid, '1.5.0', now()
       )`,
      [connectionId, workspaceId, tokenHash, userId],
    );
    await database.query(
      `update public.ai_connection_bridge_settings
       set active_runtime_instance_id = $3::uuid,
           active_runtime_last_sequence = 1,
           active_runtime_lease_expires_at = now() + interval '5 minutes'
       where workspace_id = $1::uuid and connection_id = $2::uuid`,
      [workspaceId, connectionId, runtimeId],
    );
    await database.query(
      `insert into public.ai_bridge_directories (
         workspace_id, connection_id, directory_key, name,
         working_directory, inventory_active, last_seen_at
       ) values (
         $1::uuid, $2::uuid, 'main', 'Main project',
         '/srv/main', true, now()
       )`,
      [workspaceId, connectionId],
    );
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  const enqueue = async (input: {
    commandId: string;
    action: "list" | "read";
    path: string;
  }) => {
    const result = await database.query<{ response: CommandResponse }>(
      `select public.enqueue_ai_file_command(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        userId,
        input.commandId,
        connectionId,
        input.action,
        input.path,
      ],
    );
    return result.rows[0].response;
  };

  const claim = async (runtimeInstanceId = runtimeId) => {
    const result = await database.query<{ response: CommandResponse }>(
      `select public.claim_ai_file_command(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 60
       ) as response`,
      [workspaceId, connectionId, tokenHash, runtimeInstanceId],
    );
    return result.rows[0].response;
  };

  const complete = async (
    commandId: string,
    succeeded: boolean,
    result: unknown,
    error: string | null,
  ) => {
    const response = await database.query<{ response: CommandResponse }>(
      `select public.complete_ai_file_command(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
         $6::boolean, $7::jsonb, $8::text
       ) as response`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        runtimeId,
        commandId,
        succeeded,
        result === null ? null : JSON.stringify(result),
        error,
      ],
    );
    return response.rows[0].response;
  };

  it("enqueues, claims and completes a list command with its result", async () => {
    const commandId = randomUUID();
    const queued = await enqueue({
      commandId,
      action: "list",
      path: "/srv/main/src",
    });
    expect(queued.command).toMatchObject({ status: "queued", path: "/srv/main/src" });

    const claimed = await claim();
    expect(claimed.command).toMatchObject({
      id: commandId,
      status: "running",
      runtime_instance_id: runtimeId,
    });

    const payload = {
      path: "/srv/main/src",
      name: "src",
      entries: [{ name: "index.ts", path: "/srv/main/src/index.ts", type: "file", size: 42, modifiedAt: null }],
      truncated: false,
    };
    const completed = await complete(commandId, true, payload, null);
    expect(completed.command).toMatchObject({ status: "succeeded" });
    expect(completed.command?.result).toEqual(payload);
  });

  it("rejects invalid actions and paths", async () => {
    await expect(
      enqueue({
        commandId: randomUUID(),
        action: "write" as "read",
        path: "/srv/main/src",
      }),
    ).rejects.toThrow(/INVALID_FILE_COMMAND/);
    await expect(
      enqueue({
        commandId: randomUUID(),
        action: "list",
        path: "  ",
      }),
    ).rejects.toThrow(/INVALID_FILE_COMMAND/);
  });

  it("only lets the active runtime instance claim or complete", async () => {
    await expect(claim(otherRuntimeId)).rejects.toThrow(
      /BRIDGE_INSTANCE_CONFLICT/,
    );

    const commandId = randomUUID();
    await enqueue({ commandId, action: "read", path: "/srv/main/README.md" });
    const claimed = await claim();
    expect(claimed.command?.id).toBe(commandId);

    await expect(
      complete(commandId, true, null, null),
    ).rejects.toThrow(/INVALID_FILE_COMMAND/);
    await expect(
      complete(commandId, false, null, null),
    ).rejects.toThrow(/INVALID_FILE_COMMAND/);

    const failed = await complete(commandId, false, null, "读取失败");
    expect(failed.command).toMatchObject({ status: "failed", error: "读取失败" });
  });
});

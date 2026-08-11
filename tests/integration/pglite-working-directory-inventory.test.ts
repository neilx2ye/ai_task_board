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
];

type InventoryResponse = {
  sessions: Array<{
    id: string;
    external_conversation_ref: string;
    bridge_directory_key: string | null;
  }>;
};

describe("Bridge working-directory inventory migration", () => {
  let database: PGlite;
  const userId = randomUUID();
  const connectionId = randomUUID();
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
      [userId, `bridge-directories-${userId}@example.invalid`],
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
         $4::uuid, '0.7.0', now()
       )`,
      [connectionId, workspaceId, tokenHash, userId],
    );
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  async function syncInventory(
    directories: unknown[],
    threads: unknown[],
    suffix: string,
  ) {
    const result = await database.query<{ response: InventoryResponse }>(
      `select public.sync_ai_sessions_with_directories(
         $1::uuid, $2::uuid, $3::text, '0.7.0',
         $4::jsonb, $5::jsonb, $6::text, $7::text
       ) as response`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        JSON.stringify(directories),
        JSON.stringify(threads),
        `inventory-${suffix}`,
        `inventory-${suffix}-request-hash`.padEnd(64, "0"),
      ],
    );
    return result.rows[0].response;
  }

  it("atomically groups Threads under device-reported directory keys", async () => {
    const response = await syncInventory(
      [
        {
          directory_key: "main",
          name: "Main app",
          working_directory: "/workspace/main",
        },
        {
          directory_key: "docs",
          name: "Docs",
          working_directory: "/workspace/docs",
        },
      ],
      [
        {
          external_conversation_ref: "thread-main",
          name: "Main Thread",
          working_directory: "/workspace/main",
          directory_key: "main",
        },
        {
          external_conversation_ref: "thread-docs",
          name: "Docs Thread",
          working_directory: "/workspace/docs",
          directory_key: "docs",
        },
      ],
      "first",
    );

    expect(response.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_conversation_ref: "thread-main",
          bridge_directory_key: "main",
        }),
        expect.objectContaining({
          external_conversation_ref: "thread-docs",
          bridge_directory_key: "docs",
        }),
      ]),
    );

    const directoryRows = await database.query<{
      directory_key: string;
      inventory_active: boolean;
    }>(
      `select directory_key, inventory_active
       from public.ai_bridge_directories
       where connection_id = $1::uuid
       order by directory_key`,
      [connectionId],
    );
    expect(directoryRows.rows).toEqual([
      { directory_key: "docs", inventory_active: true },
      { directory_key: "main", inventory_active: true },
    ]);
  });

  it("stores only a directory key on Web create commands", async () => {
    const commandId = randomUUID();
    const runtimeInstanceId = randomUUID();
    const result = await database.query<{
      response: { command: { id: string; directory_key: string | null } };
    }>(
      `select public.enqueue_ai_thread_command_with_directory(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, null::uuid,
         'create', 'New docs Thread', 'docs', $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        userId,
        commandId,
        connectionId,
        "create-docs-thread",
        "create-docs-thread-request-hash".padEnd(64, "0"),
      ],
    );

    expect(result.rows[0].response.command).toMatchObject({
      id: commandId,
      directory_key: "docs",
    });
    expect(JSON.stringify(result.rows[0].response.command)).not.toContain(
      "/workspace/docs",
    );

    await database.query(
      `update public.ai_connection_bridge_settings
       set active_runtime_instance_id = $1::uuid,
           active_runtime_last_sequence = 1,
           active_runtime_lease_expires_at = now() + interval '5 minutes'
       where workspace_id = $2::uuid and connection_id = $3::uuid`,
      [runtimeInstanceId, workspaceId, connectionId],
    );
    const claimed = await database.query<{
      response: { command: { id: string; directory_key: string | null } };
    }>(
      `select public.claim_ai_thread_command(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 60
       ) as response`,
      [workspaceId, connectionId, tokenHash, runtimeInstanceId],
    );
    expect(claimed.rows[0].response.command).toMatchObject({
      id: commandId,
      directory_key: "docs",
    });
    expect(JSON.stringify(claimed.rows[0].response.command)).not.toContain(
      "/workspace/docs",
    );
  });

  it("rejects an empty new-style directory allowlist", async () => {
    await expect(syncInventory([], [], "empty-directories")).rejects.toThrow(
      "INVALID_SESSION",
    );
  });

  it("keeps legacy inventory compatible when an optional key is explicitly null", async () => {
    const result = await database.query<{ response: InventoryResponse }>(
      `select public.sync_ai_sessions_with_directories(
         $1::uuid, $2::uuid, $3::text, '0.6.0', null::jsonb,
         $4::jsonb, $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        JSON.stringify([
          {
            external_conversation_ref: "thread-legacy",
            name: "Legacy Thread",
            working_directory: "/workspace/legacy",
            directory_key: null,
          },
        ]),
        "inventory-legacy-null-key",
        "inventory-legacy-null-key-request-hash".padEnd(64, "0"),
      ],
    );

    expect(result.rows[0].response.sessions).toEqual([
      expect.objectContaining({
        external_conversation_ref: "thread-legacy",
        bridge_directory_key: null,
      }),
    ]);
  });

  it("marks removed directories and omitted Sessions inactive without deleting history", async () => {
    await syncInventory(
      [
        {
          directory_key: "main",
          name: "Main app",
          working_directory: "/workspace/main",
        },
      ],
      [
        {
          external_conversation_ref: "thread-main",
          name: "Main Thread",
          working_directory: "/workspace/main",
          directory_key: "main",
        },
      ],
      "second",
    );

    const removedDirectory = await database.query<{
      inventory_active: boolean;
    }>(
      `select inventory_active
       from public.ai_bridge_directories
       where connection_id = $1::uuid and directory_key = 'docs'`,
      [connectionId],
    );
    const omittedSession = await database.query<{
      inventory_active: boolean;
      status: string;
      bridge_directory_key: string | null;
    }>(
      `select inventory_active, status, bridge_directory_key
       from public.ai_sessions
       where connection_id = $1::uuid
         and external_conversation_ref = 'thread-docs'`,
      [connectionId],
    );

    expect(removedDirectory.rows[0].inventory_active).toBe(false);
    expect(omittedSession.rows[0]).toMatchObject({
      inventory_active: false,
      status: "offline",
      bridge_directory_key: "docs",
    });
  });
});

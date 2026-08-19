import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");

describe("Unified device Bridge migration", () => {
  let database: PGlite;
  let workspaceId: string;
  const userId = randomUUID();
  const unifiedId = randomUUID();
  const tokenHash = "unified-token-hash".repeat(4);

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
      [userId, `unified-${userId}@example.invalid`],
    );
    const membership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [userId],
    );
    workspaceId = membership.rows[0].workspace_id;
    await database.query(
      `insert into public.ai_connections
         (id, workspace_id, name, platform, api_token_hash, created_by_user_id)
       values ($1, $2, 'Laptop', 'All', $3, $4)`,
      [unifiedId, workspaceId, tokenHash, userId],
    );
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  it("creates a codex settings row for an All connection and adds kinds lazily", async () => {
    const initial = await database.query<{ platform: string }>(
      `select platform from public.ai_connection_bridge_settings
       where connection_id = $1`,
      [unifiedId],
    );
    expect(initial.rows.map((row) => row.platform)).toEqual(["codex"]);

    const kimiRuntimeId = randomUUID();
    const exchange = await database.query<{
      response: { configuration: { platform: string } };
    }>(
      `select public.exchange_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::text, 'kimi',
         $4::uuid, $5::bigint, $6::integer, false,
         null, $7::jsonb, $8::jsonb, null
       ) as response`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        kimiRuntimeId,
        1,
        60,
        JSON.stringify({
          enabled: true,
          include_thread_titles: false,
          max_threads: 40,
          max_concurrent_turns: 2,
        }),
        JSON.stringify({
          remote_configuration_enabled: true,
          allow_thread_titles: true,
          max_threads: 40,
          max_concurrent_turns: 2,
          thread_scope: "cwd",
          working_directory: "/srv",
          fixed_thread: false,
          permission_mode: "danger-full-access",
          approval_mode: "accept",
        }),
      ],
    );
    expect(exchange.rows[0].response.configuration.platform).toBe("kimi");

    await database.query(
      `select public.exchange_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::text, 'kimi',
         $4::uuid, $5::bigint, $6::integer, true,
         null, $7::jsonb, $8::jsonb, null
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        kimiRuntimeId,
        2,
        60,
        JSON.stringify({
          enabled: true,
          include_thread_titles: false,
          max_threads: 40,
          max_concurrent_turns: 2,
        }),
        JSON.stringify({
          remote_configuration_enabled: true,
          allow_thread_titles: true,
          max_threads: 40,
          max_concurrent_turns: 2,
          thread_scope: "cwd",
          working_directory: "/srv",
          fixed_thread: false,
          permission_mode: "danger-full-access",
          approval_mode: "accept",
        }),
      ],
    );
  });

  it("keeps separate directory rows per runtime for the same path", async () => {
    for (const [kind, key] of [
      ["codex", "main"],
      ["kimi", "kimi-main"],
    ] as const) {
      await database.query(
        `select public.sync_ai_sessions_with_directories(
           $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::jsonb,
           $7::jsonb, $8::text, $9::text
         )`,
        [
          workspaceId,
          unifiedId,
          tokenHash,
          "1.6.0",
          kind,
          JSON.stringify([
            {
              directory_key: key,
              name: "Main",
              working_directory:
                kind === "kimi" ? "/srv/kimi-main" : "/srv/main",
            },
          ]),
          JSON.stringify([
            {
              external_conversation_ref: `${kind}-thread-1`,
              name: `${kind} thread`,
              platform: kind,
              working_directory:
                kind === "kimi" ? "/srv/kimi-main" : "/srv/main",
              directory_key: key,
              capabilities: [],
              archived: false,
            },
          ]),
          `verify-sync-${kind}`,
          `verify-sync-hash-${kind}`,
        ],
      );
    }

    const directories = await database.query<{
      platform: string;
      directory_key: string;
      working_directory: string;
    }>(
      `select platform, directory_key, working_directory
       from public.ai_bridge_directories
       where connection_id = $1
       order by platform`,
      [unifiedId],
    );
    expect(directories.rows).toEqual([
      {
        platform: "codex",
        directory_key: "main",
        working_directory: "/srv/main",
      },
      {
        platform: "kimi",
        directory_key: "kimi-main",
        working_directory: "/srv/kimi-main",
      },
    ]);

    // The same directory_key is allowed across platforms under one
    // connection after the legacy connection-wide unique constraint is gone.
    await database.query(
      `select public.sync_ai_sessions_with_directories(
         $1::uuid, $2::uuid, $3::text, $4::text, 'kimi', $5::jsonb,
         '[]'::jsonb, $6::text, $7::text
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        "1.6.0",
        JSON.stringify([
          {
            directory_key: "main",
            name: "Main",
            working_directory: "/srv/main",
          },
        ]),
        "verify-sync-key-overlap",
        "verify-sync-hash-key-overlap",
      ],
    );
    const overlap = await database.query<{ platform: string; directory_key: string }>(
      `select platform, directory_key from public.ai_bridge_directories
       where connection_id = $1 and directory_key = 'main' order by platform`,
      [unifiedId],
    );
    expect(overlap.rows.map((row) => row.platform)).toEqual([
      "codex",
      "kimi",
    ]);
  });

  it("scopes session inventory omission to the reporting runtime", async () => {
    const kimiEmptySync = await database.query(
      `select public.sync_ai_sessions_with_directories(
         $1::uuid, $2::uuid, $3::text, $4::text, 'kimi', $5::jsonb,
         '[]'::jsonb, $6::text, $7::text
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        "1.6.0",
        JSON.stringify([
          {
            directory_key: "main",
            name: "Main",
            working_directory: "/srv/main",
          },
          {
            directory_key: "kimi-empty",
            name: "Kimi empty",
            working_directory: "/srv/kimi-empty",
          },
        ]),
        "verify-sync-omission",
        "verify-sync-hash-omission",
      ],
    );
    expect(kimiEmptySync.affectedRows).toBeDefined();

    const sessions = await database.query<{
      platform: string;
      status: string;
      inventory_active: boolean;
    }>(
      `select platform, status, inventory_active from public.ai_sessions
       where connection_id = $1 order by platform`,
      [unifiedId],
    );
    const codexSession = sessions.rows.find(
      (session) => session.platform === "codex",
    );
    expect(codexSession).toMatchObject({
      status: "online",
      inventory_active: true,
    });
  });

  it("scopes Web thread commands to the claiming runtime kind", async () => {
    const commandId = randomUUID();
    const kimiRuntimeId = randomUUID();
    await database.query(
      `select public.exchange_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::text, 'kimi',
         $4::uuid, $5::bigint, $6::integer, false,
         null, $7::jsonb, $8::jsonb, null
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        kimiRuntimeId,
        2,
        300,
        JSON.stringify({
          enabled: true,
          include_thread_titles: false,
          max_threads: 40,
          max_concurrent_turns: 2,
        }),
        JSON.stringify({
          remote_configuration_enabled: true,
          allow_thread_titles: true,
          max_threads: 40,
          max_concurrent_turns: 2,
          thread_scope: "cwd",
          working_directory: "/srv",
          fixed_thread: false,
          permission_mode: "safe",
          approval_mode: "accept",
        }),
      ],
    );
    await database.query(
      `select public.enqueue_ai_thread_command_with_settings(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, null,
         'create', 'New kimi thread', 'main', null, null, 'kimi',
         $5::text, $6::text
       )`,
      [
        workspaceId,
        userId,
        commandId,
        unifiedId,
        "verify-enqueue-1",
        "verify-enqueue-hash-1",
      ],
    );

    const claimed = await database.query<{
      command: {
        command: { id: string; platform: string; status: string } | null;
      } | null;
    }>(
      `select public.claim_ai_thread_command(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::integer, 'kimi'
       ) as command`,
      [workspaceId, unifiedId, tokenHash, kimiRuntimeId, 60],
    );
    expect(claimed.rows[0].command?.command).toMatchObject({
      id: commandId,
      platform: "kimi",
      status: "running",
    });
  });
});

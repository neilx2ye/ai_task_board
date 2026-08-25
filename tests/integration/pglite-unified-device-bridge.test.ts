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
    const initial = await database.query<{
      platform: string;
      desired_include_thread_titles: boolean;
      desired_max_concurrent_turns: number;
      desired_sync_history: boolean;
      desired_permission_mode: string | null;
      desired_approval_mode: string | null;
    }>(
      `select platform, desired_include_thread_titles,
              desired_max_concurrent_turns, desired_sync_history,
              desired_permission_mode, desired_approval_mode
       from public.ai_connection_bridge_settings
       where connection_id = $1`,
      [unifiedId],
    );
    expect(initial.rows).toEqual([
      {
        platform: "codex",
        desired_include_thread_titles: true,
        desired_max_concurrent_turns: 5,
        desired_sync_history: true,
        desired_permission_mode: "danger-full-access",
        desired_approval_mode: "accept",
      },
    ]);

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
    const kimiDefaults = await database.query<{
      desired_include_thread_titles: boolean;
      desired_sync_history: boolean;
      desired_permission_mode: string | null;
      desired_approval_mode: string | null;
    }>(
      `select desired_include_thread_titles, desired_sync_history,
              desired_permission_mode, desired_approval_mode
       from public.ai_connection_bridge_settings
       where connection_id = $1 and platform = 'kimi'`,
      [unifiedId],
    );
    expect(kimiDefaults.rows[0]).toEqual({
      desired_include_thread_titles: true,
      desired_sync_history: false,
      desired_permission_mode: null,
      desired_approval_mode: null,
    });

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

  it("owns Codex runtime safety modes from the Web and reports them back", async () => {
    const updated = await database.query<{
      response: {
        configuration: {
          version: number;
          desired: {
            permission_mode: string | null;
            approval_mode: string | null;
          };
        };
      };
    }>(
      `select public.update_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::uuid, 'codex', $4::integer,
         true, true, 50, 5, true, 50, null::jsonb,
         'safe', 'decline', 'bridge-config/safety-modes',
         $5::text
       ) as response`,
      [workspaceId, userId, unifiedId, 1, "safety-hash".padEnd(64, "0")],
    );
    expect(updated.rows[0].response.configuration.version).toBe(2);
    expect(updated.rows[0].response.configuration.desired).toMatchObject({
      permission_mode: "safe",
      approval_mode: "decline",
    });

    const codexRuntimeId = randomUUID();
    await database.query(
      `select public.exchange_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::text, 'codex',
         $4::uuid, $5::bigint, $6::integer, false,
         2, $7::jsonb, $8::jsonb, null
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        codexRuntimeId,
        1,
        60,
        JSON.stringify({
          enabled: true,
          include_thread_titles: true,
          max_threads: 50,
          max_concurrent_turns: 5,
          sync_history: true,
          history_turn_limit: 50,
          working_directories: null,
          permission_mode: "safe",
          approval_mode: "decline",
        }),
        JSON.stringify({
          remote_configuration_enabled: true,
          allow_thread_titles: true,
          max_threads: 500,
          max_concurrent_turns: 32,
          thread_scope: "cwd",
          working_directory: "/srv",
          fixed_thread: false,
          permission_mode: "safe",
          approval_mode: "decline",
          allow_history_sync: true,
          max_history_turns: 500,
          allow_working_directory_configuration: true,
        }),
      ],
    );

    const persisted = await database.query<{
      effective_permission_mode: string | null;
      effective_approval_mode: string | null;
      constraint_permission_mode: string | null;
      constraint_approval_mode: string | null;
    }>(
      `select effective_permission_mode, effective_approval_mode,
              constraint_permission_mode, constraint_approval_mode
       from public.ai_connection_bridge_settings
       where connection_id = $1 and platform = 'codex'`,
      [unifiedId],
    );
    expect(persisted.rows[0]).toEqual({
      effective_permission_mode: "safe",
      effective_approval_mode: "decline",
      constraint_permission_mode: "safe",
      constraint_approval_mode: "decline",
    });
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
          "1.8.1",
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
        "1.8.1",
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

  it("adopts a renamed directory key for an existing path on the same runtime", async () => {
    await database.query(
      `insert into public.ai_thread_commands (
         workspace_id, connection_id, action, name, status, platform,
         directory_key
       ) values ($1::uuid, $2::uuid, 'create', 'New main thread',
                 'queued', 'codex', 'main')`,
      [workspaceId, unifiedId],
    );

    await database.query(
      `select public.sync_ai_sessions_with_directories(
         $1::uuid, $2::uuid, $3::text, $4::text, 'codex', $5::jsonb,
         $6::jsonb, $7::text, $8::text
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        "1.8.1",
        JSON.stringify([
          {
            directory_key: "main-renamed",
            name: "Main renamed",
            working_directory: "/srv/main",
          },
        ]),
        JSON.stringify([
          {
            external_conversation_ref: "codex-thread-1",
            name: "codex thread",
            platform: "codex",
            working_directory: "/srv/main",
            directory_key: "main-renamed",
            capabilities: [],
            archived: false,
          },
        ]),
        "verify-sync-rekey",
        "verify-sync-hash-rekey",
      ],
    );

    const directories = await database.query<{
      directory_key: string;
      working_directory: string;
    }>(
      `select directory_key, working_directory
       from public.ai_bridge_directories
       where connection_id = $1 and platform = 'codex'`,
      [unifiedId],
    );
    expect(directories.rows).toEqual([
      {
        directory_key: "main-renamed",
        working_directory: "/srv/main",
      },
    ]);

    const session = await database.query<{ bridge_directory_key: string | null }>(
      `select bridge_directory_key from public.ai_sessions
       where connection_id = $1 and external_conversation_ref = 'codex-thread-1'`,
      [unifiedId],
    );
    expect(session.rows[0].bridge_directory_key).toBe("main-renamed");

    const command = await database.query<{ directory_key: string | null }>(
      `select directory_key from public.ai_thread_commands
       where connection_id = $1 and platform = 'codex'`,
      [unifiedId],
    );
    expect(command.rows[0].directory_key).toBe("main-renamed");
  });

  it("rejects a renamed key when the new key is already used by another path", async () => {
    await database.query(
      `select public.sync_ai_sessions_with_directories(
         $1::uuid, $2::uuid, $3::text, $4::text, 'codex', $5::jsonb,
         $6::jsonb, $7::text, $8::text
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        "1.8.1",
        JSON.stringify([
          {
            directory_key: "main-renamed",
            name: "Main renamed",
            working_directory: "/srv/main",
          },
          {
            directory_key: "other",
            name: "Other",
            working_directory: "/srv/other",
          },
        ]),
        JSON.stringify([
          {
            external_conversation_ref: "codex-thread-1",
            name: "codex thread",
            platform: "codex",
            working_directory: "/srv/main",
            directory_key: "main-renamed",
            capabilities: [],
            archived: false,
          },
        ]),
        "verify-sync-conflict-setup",
        "verify-sync-hash-conflict-setup",
      ],
    );

    await expect(
      database.query(
        `select public.sync_ai_sessions_with_directories(
           $1::uuid, $2::uuid, $3::text, $4::text, 'codex', $5::jsonb,
           '[]'::jsonb, $6::text, $7::text
         )`,
        [
          workspaceId,
          unifiedId,
          tokenHash,
          "1.8.1",
          JSON.stringify([
            {
              directory_key: "other",
              name: "Main renamed",
              working_directory: "/srv/main",
            },
            {
              directory_key: "other-2",
              name: "Other",
              working_directory: "/srv/other",
            },
          ]),
          "verify-sync-conflict",
          "verify-sync-hash-conflict",
        ],
      ),
    ).rejects.toThrow("INVALID_SESSION");
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
        "1.8.1",
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

  it("accepts an empty directory report and retires the runtime directories", async () => {
    await database.query(
      `select public.sync_ai_sessions_with_directories(
         $1::uuid, $2::uuid, $3::text, $4::text, 'codex', $5::jsonb,
         $6::jsonb, $7::text, $8::text
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        "1.8.1",
        JSON.stringify([
          {
            directory_key: "retire",
            name: "Retire",
            working_directory: "/srv/retire",
          },
        ]),
        JSON.stringify([
          {
            external_conversation_ref: "codex-thread-retire",
            name: "codex retire thread",
            platform: "codex",
            working_directory: "/srv/retire",
            directory_key: "retire",
            capabilities: [],
            archived: false,
          },
        ]),
        "verify-empty-report-setup",
        "verify-empty-report-hash-setup",
      ],
    );

    await database.query(
      `select public.sync_ai_sessions_with_directories(
         $1::uuid, $2::uuid, $3::text, $4::text, 'codex', '[]'::jsonb,
         '[]'::jsonb, $5::text, $6::text
       )`,
      [
        workspaceId,
        unifiedId,
        tokenHash,
        "1.8.1",
        "verify-empty-report",
        "verify-empty-report-hash",
      ],
    );

    const directory = await database.query<{ inventory_active: boolean }>(
      `select inventory_active from public.ai_bridge_directories
       where connection_id = $1 and platform = 'codex'
         and working_directory = '/srv/retire'`,
      [unifiedId],
    );
    expect(directory.rows[0]?.inventory_active).toBe(false);

    const session = await database.query<{
      status: string;
      inventory_active: boolean;
    }>(
      `select status, inventory_active from public.ai_sessions
       where connection_id = $1
         and external_conversation_ref = 'codex-thread-retire'`,
      [unifiedId],
    );
    expect(session.rows[0]).toMatchObject({
      status: "offline",
      inventory_active: false,
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

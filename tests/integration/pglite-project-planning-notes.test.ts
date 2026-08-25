import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");

const baseMigrations = [
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
];

const projectNoteMigration = "20260821000000_project_planning_notes.sql";

describe("Project-scoped planning notes migration", () => {
  let database: PGlite;
  let workspaceId: string;
  const userId = randomUUID();
  const firstConnectionId = randomUUID();
  const secondConnectionId = randomUUID();

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

    for (const migrationName of baseMigrations) {
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
      [userId, `project-notes-${userId}@example.invalid`],
    );
    const membership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [userId],
    );
    workspaceId = membership.rows[0].workspace_id;

    for (const [connectionId, name] of [
      [firstConnectionId, "Laptop"],
      [secondConnectionId, "Desktop"],
    ] as const) {
      await database.query(
        `insert into public.ai_connections (
           id, workspace_id, name, platform, api_token_hash,
           created_by_user_id, bridge_version, last_seen_at
         ) values (
           $1::uuid, $2::uuid, $3::text, 'Codex', $4::text,
           $5::uuid, '0.7.0', now()
         )`,
        [connectionId, workspaceId, name, randomUUID().repeat(2), userId],
      );
    }

    // Two Bridges serve the same project path under different local keys.
    await database.query(
      `insert into public.ai_bridge_directories (
         workspace_id, connection_id, directory_key, name, working_directory
       ) values
         ($1::uuid, $2::uuid, 'main', 'Main app', '/srv/main'),
         ($1::uuid, $3::uuid, 'app', 'Main app', '/srv/main')`,
      [workspaceId, firstConnectionId, secondConnectionId],
    );

    await database.query(
      `insert into public.planning_notes (
         workspace_id, connection_id, directory_ref, content, updated_at
       ) values
         ($1::uuid, $2::uuid, 'configured:main', 'first note',
          '2026-08-16 12:00:00+00'),
         ($1::uuid, $3::uuid, 'configured:app', 'second note',
          '2026-08-17 12:00:00+00'),
         ($1::uuid, $3::uuid, 'path:/other/repo', 'path note',
          '2026-08-17 12:00:00+00'),
         ($1::uuid, $2::uuid, 'unassigned', 'unassigned note',
          '2026-08-17 12:00:00+00'),
         ($1::uuid, $2::uuid, 'configured:missing', 'legacy note',
          '2026-08-17 12:00:00+00')`,
      [workspaceId, firstConnectionId, secondConnectionId],
    );

    const migration = await readFile(
      path.join(migrationsDirectory, projectNoteMigration),
      "utf8",
    );
    await database.exec(
      migration.replace(
        "create extension if not exists pgcrypto with schema extensions;",
        "",
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("merges per-Bridge notes into one note per project path", async () => {
    const result = await database.query<{
      project_ref: string;
      content: string;
    }>(`
      select project_ref, content
      from public.planning_notes
      order by project_ref
    `);

    expect(result.rows).toEqual([
      { project_ref: `connection:${firstConnectionId}:configured:missing`, content: "legacy note" },
      { project_ref: "path:/other/repo", content: "path note" },
      // 同一路径的两条 Bridge 笔记合并，保留最近更新的一条。
      { project_ref: "path:/srv/main", content: "second note" },
      { project_ref: "unassigned", content: "unassigned note" },
    ]);
  });

  it("drops the per-Bridge identity columns", async () => {
    const result = await database.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'planning_notes'
    `);
    const columns = result.rows.map((row) => row.column_name);

    expect(columns).toContain("project_ref");
    expect(columns).not.toContain("connection_id");
    expect(columns).not.toContain("directory_ref");
  });

  it("enforces one note per workspace and project", async () => {
    await expect(
      database.query(
        `insert into public.planning_notes (
           workspace_id, project_ref, content
         ) values ($1::uuid, 'path:/srv/main', 'duplicate')`,
        [workspaceId],
      ),
    ).rejects.toThrow();
  });
});

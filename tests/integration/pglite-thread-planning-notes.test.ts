import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");

describe("Thread-scoped planning notes migration", () => {
  let database: PGlite;
  let workspaceId: string;
  const userId = randomUUID();
  const connectionId = randomUUID();
  const sessionId = randomUUID();

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
      [userId, `thread-notes-${userId}@example.invalid`],
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
      [connectionId, workspaceId, randomUUID().repeat(2), userId],
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

  it("stores one note per Thread with no project identity columns", async () => {
    const result = await database.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'thread_planning_notes'
    `);
    const columns = result.rows.map((row) => row.column_name);

    expect(columns).toContain("session_id");
    expect(columns).toContain("content");
    expect(columns).not.toContain("project_ref");
    expect(columns).not.toContain("connection_id");
  });

  it("enforces one note per workspace and Thread", async () => {
    await database.query(
      `insert into public.thread_planning_notes (
         workspace_id, session_id, content
       ) values ($1::uuid, $2::uuid, 'first thread note')`,
      [workspaceId, sessionId],
    );

    await expect(
      database.query(
        `insert into public.thread_planning_notes (
           workspace_id, session_id, content
         ) values ($1::uuid, $2::uuid, 'duplicate')`,
        [workspaceId, sessionId],
      ),
    ).rejects.toThrow();
  });

  it("removes the note when its Thread is deleted", async () => {
    await database.query(
      "delete from public.ai_sessions where workspace_id = $1::uuid and id = $2::uuid",
      [workspaceId, sessionId],
    );
    const result = await database.query(
      `select session_id
       from public.thread_planning_notes
       where workspace_id = $1::uuid
         and session_id = $2::uuid`,
      [workspaceId, sessionId],
    );
    expect(result.rows).toEqual([]);
  });
});

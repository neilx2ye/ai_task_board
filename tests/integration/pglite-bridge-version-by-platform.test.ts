import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");
const BRIDGE_VERSION_MIGRATION =
  "20260829000000_bridge_version_by_platform.sql";

describe("Per-platform Bridge version migration", () => {
  let database: PGlite;
  let workspaceId: string;
  const userId = randomUUID();
  const claudeId = randomUUID();
  const unifiedId = randomUUID();
  const claudeTokenHash = "claude-version-token-hash".repeat(2);
  const unifiedTokenHash = "unified-version-token-hash".repeat(2);

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

    // Apply everything before the per-platform version migration so we can
    // observe the one-time backfill on realistic pre-migration rows.
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => name < BRIDGE_VERSION_MIGRATION);
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
      [userId, `version-${userId}@example.invalid`],
    );
    const membership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [userId],
    );
    workspaceId = membership.rows[0].workspace_id;

    await database.query(
      `insert into public.ai_connections
         (id, workspace_id, name, platform, api_token_hash, created_by_user_id)
       values
         ($1, $2, 'Claude 桌面', 'Claude', $3, $4),
         ($5, $2, 'Laptop', 'All', $6, $4)`,
      [claudeId, workspaceId, claudeTokenHash, userId, unifiedId, unifiedTokenHash],
    );
    // Simulate the legacy single last-writer column having been written by
    // both connections before the new migration runs.
    await database.query(
      `update public.ai_connections
       set bridge_version = '1.7.1-claude.1'
       where id in ($1::uuid, $2::uuid)`,
      [claudeId, unifiedId],
    );

    const migration = await readFile(
      path.join(migrationsDirectory, BRIDGE_VERSION_MIGRATION),
      "utf8",
    );
    await database.exec(migration);
  }, 120_000);

  afterAll(async () => {
    await database?.close();
  });

  it("backfills single-runtime connections and leaves unified rows empty", async () => {
    const rows = await database.query<{
      platform: string;
      bridge_version: string | null;
    }>(
      `select platform, bridge_version
       from public.ai_connection_bridge_settings
       where connection_id in ($1::uuid, $2::uuid)
       order by platform`,
      [claudeId, unifiedId],
    );
    expect(rows.rows).toEqual([
      { platform: "claude", bridge_version: "1.7.1-claude.1" },
      { platform: "codex", bridge_version: null },
    ]);
  });

  it("enforces the 1 to 100 character shape on reported versions", async () => {
    await expect(
      database.query(
        `update public.ai_connection_bridge_settings
         set bridge_version = $1::text
         where connection_id = $2::uuid and platform = 'claude'`,
        ["x".repeat(101), claudeId],
      ),
    ).rejects.toThrow();
  });
});

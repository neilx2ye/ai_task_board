import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = path.resolve(process.cwd());
const migrationsDir = path.join(projectRoot, "supabase", "migrations");
const bootstrapFile = path.join(projectRoot, "supabase", "local", "bootstrap.sql");
const seedFile = path.join(projectRoot, "supabase", "seed.sql");

// The hosted migration installs pgcrypto into `extensions`; the local bootstrap
// provides extensions.gen_random_uuid() directly, matching scripts/init-local-db.mjs.
const PGCRYPTO_LINE =
  "create extension if not exists pgcrypto with schema extensions;";

describe("local bootstrap and full migration chain", () => {
  let database: PGlite;

  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;
    await database.exec(await readFile(bootstrapFile, "utf8"));

    const migrationNames = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of migrationNames) {
      const sql = (
        await readFile(path.join(migrationsDir, name), "utf8")
      ).replace(PGCRYPTO_LINE, "");
      await database.exec(sql);
    }

    await database.exec(await readFile(seedFile, "utf8"));
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates the core tables and the demo workspace in one pass", async () => {
    const tables = await database.query<{ name: string }>(
      `select table_name as name
       from information_schema.tables
       where table_schema = 'public'
       order by table_name`,
    );
    const names = tables.rows.map((row) => row.name);
    for (const expected of [
      "workspaces",
      "workspace_members",
      "ai_connections",
      "ai_sessions",
      "tasks",
      "task_dependencies",
      "task_messages",
      "task_events",
      "artifacts",
      "idempotency_records",
      "session_activities",
      "planning_notes",
    ]) {
      expect(names).toContain(expected);
    }

    const demo = await database.query<{ id: string }>(
      `select id from public.workspaces where name = 'AI Task Board Demo'`,
    );
    expect(demo.rows).toHaveLength(1);
  });

  it("provides the bootstrap compatibility ledger", async () => {
    const result = await database.query<{ exists: boolean }>(
      `select exists(
         select 1 from supabase_migrations.schema_migrations
       ) as exists`,
    );
    expect(result.rows[0]?.exists).toBe(false);
  });
});

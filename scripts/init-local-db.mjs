#!/usr/bin/env node
/**
 * One-command local PostgreSQL deployment for AI Task Board.
 *
 * Applies supabase/local/bootstrap.sql, then every supabase/migrations/*.sql in
 * filename order, then optionally supabase/seed.sql. Files already recorded in
 * supabase_migrations.schema_migrations are skipped, so re-running is safe.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ai_task_board \
 *     node scripts/init-local-db.mjs
 *   node scripts/init-local-db.mjs --seed
 *
 * Defaults to postgresql:///ai_task_board_local (local socket, current OS
 * user). Requires the psql and createdb client binaries on PATH.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapFile = path.join(projectRoot, "supabase", "local", "bootstrap.sql");
const realtimeTriggersFile = path.join(
  projectRoot,
  "supabase",
  "local",
  "realtime-triggers.sql",
);
const migrationsDir = path.join(projectRoot, "supabase", "migrations");
const seedFile = path.join(projectRoot, "supabase", "seed.sql");

// The hosted migration installs pgcrypto into `extensions`. The local bootstrap
// already provides extensions.gen_random_uuid(), so this line must not run
// against a local database: it would either require the contrib package or
// collide with the bootstrap shim.
const PGCRYPTO_LINE =
  "create extension if not exists pgcrypto with schema extensions;";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/init-local-db.mjs [--seed]

Environment:
  DATABASE_URL   PostgreSQL connection URI. Defaults to postgresql:///ai_task_board_local.
  PGSSLMODE      Optional; also accepted as ?sslmode= inside DATABASE_URL.

Flags:
  --seed         Apply supabase/seed.sql after the migrations (demo data).
  --help         Show this help.
`);
  process.exit(0);
}
const applySeed = args.includes("--seed");
const rawUrl = process.env.DATABASE_URL ?? "postgresql:///ai_task_board_local";

function fail(message) {
  console.error(`\ninit-local-db: ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(rawUrl);
} catch {
  fail(`DATABASE_URL is not a valid URI: ${rawUrl}`);
}
if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
  fail(
    `DATABASE_URL must use the postgresql:// scheme (got ${parsed.protocol}//)`,
  );
}

const connection = {
  host: parsed.hostname || undefined,
  port: parsed.port || undefined,
  user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
  password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres",
  sslmode: parsed.searchParams.get("sslmode") ?? undefined,
};

function psqlEnv() {
  const env = { ...process.env };
  if (connection.password) env.PGPASSWORD = connection.password;
  if (connection.sslmode) env.PGSSLMODE = connection.sslmode;
  return env;
}

function psqlBaseArgs(database) {
  const base = ["-X", "-q", "-w", "-v", "ON_ERROR_STOP=1"];
  if (connection.host) base.push("-h", connection.host);
  if (connection.port) base.push("-p", connection.port);
  if (connection.user) base.push("-U", connection.user);
  base.push("-d", database);
  return base;
}

function runSql(database, sql, extraArgs = []) {
  return spawnSync("psql", [...psqlBaseArgs(database), ...extraArgs], {
    env: psqlEnv(),
    input: sql,
    encoding: "utf8",
  });
}

function canConnect(database) {
  return (
    spawnSync("psql", [...psqlBaseArgs(database), "-tAc", "select 1"], {
      env: psqlEnv(),
      encoding: "utf8",
    }).status === 0
  );
}

function queryText(database, sql) {
  const result = spawnSync("psql", [...psqlBaseArgs(database), "-tAc", sql], {
    env: psqlEnv(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`could not query ${database}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function escapeLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function applySql(label, sql) {
  const result = runSql(connection.database, sql, ["-1"]);
  if (result.status !== 0) {
    fail(`failed while applying ${label}:\n${result.stderr.trim()}`);
  }
}

function migrationApplied(version) {
  return (
    queryText(
      connection.database,
      `select 1 from supabase_migrations.schema_migrations where version = ${escapeLiteral(version)}`,
    ) === "1"
  );
}

function recordMigration(version, name) {
  const result = runSql(
    connection.database,
    `insert into supabase_migrations.schema_migrations (version, name)
     values (${escapeLiteral(version)}, ${escapeLiteral(name)})
     on conflict (version) do nothing;`,
  );
  if (result.status !== 0) {
    fail(`could not record migration ${version}: ${result.stderr.trim()}`);
  }
}

// --- preflight -------------------------------------------------------------
const versionCheck = spawnSync("psql", ["--version"], { encoding: "utf8" });
if (versionCheck.error || versionCheck.status !== 0) {
  fail(
    "psql not found on PATH. Install the PostgreSQL client, for example `sudo apt-get install -y postgresql-client`.",
  );
}

const maintenanceDb = canConnect("postgres")
  ? "postgres"
  : canConnect("template1")
    ? "template1"
    : undefined;

if (maintenanceDb) {
  const exists =
    queryText(
      maintenanceDb,
      `select 1 from pg_database where datname = ${escapeLiteral(connection.database)}`,
    ) === "1";
  if (!exists) {
    const createdbArgs = ["-w"];
    if (connection.host) createdbArgs.push("-h", connection.host);
    if (connection.port) createdbArgs.push("-p", connection.port);
    if (connection.user) createdbArgs.push("-U", connection.user);
    createdbArgs.push(connection.database);
    const created = spawnSync("createdb", createdbArgs, {
      env: psqlEnv(),
      encoding: "utf8",
    });
    if (created.status !== 0) {
      fail(
        `could not create database ${connection.database}: ${created.stderr.trim()}`,
      );
    }
    console.log(`created database ${connection.database}`);
  }
} else if (!canConnect(connection.database)) {
  fail(
    `cannot reach PostgreSQL. Check DATABASE_URL (${rawUrl}) and that the server is running.`,
  );
}

// --- apply -----------------------------------------------------------------
console.log(`target database: ${connection.database}`);
applySql("supabase/local/bootstrap.sql", readFileSync(bootstrapFile, "utf8"));

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
let applied = 0;
let skipped = 0;
for (const fileName of files) {
  const version = fileName.replace(/\.sql$/, "");
  if (migrationApplied(version)) {
    skipped += 1;
    continue;
  }
  const sql = readFileSync(path.join(migrationsDir, fileName), "utf8").replace(
    PGCRYPTO_LINE,
    "",
  );
  applySql(fileName, sql);
  recordMigration(version, version);
  console.log(`applied ${fileName}`);
  applied += 1;
}

// Local-only change-notification triggers. They reference public tables that
// only exist after the migrations, so they are applied afterwards and stay
// outside the canonical migration ledger.
applySql(
  "supabase/local/realtime-triggers.sql",
  readFileSync(realtimeTriggersFile, "utf8"),
);

if (applySeed) {
  applySql("supabase/seed.sql", readFileSync(seedFile, "utf8"));
  console.log("applied supabase/seed.sql");
}

console.log(
  `\nDone. ${applied} migration(s) applied, ${skipped} skipped (already recorded).`,
);
console.log(
  `Database ${connection.database} is ready (${connection.host ?? "local socket"}).`,
);

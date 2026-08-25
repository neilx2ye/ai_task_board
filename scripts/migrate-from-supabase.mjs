#!/usr/bin/env node
/* global process */
/**
 * One-shot migration from a hosted Supabase project into the local PostgreSQL.
 *
 * Reads the hosted project URL and service key from .env.local
 * (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY), pulls every durable
 * business table through PostgREST, remaps hosted auth-user ids to the local
 * accounts with the same email, and inserts rows in foreign-key order with
 * `on conflict do nothing` so re-runs are safe.
 *
 *   sudo -u ai-task-board node scripts/migrate-from-supabase.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(file) {
  const entries = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

const localEnv = loadEnvFile(path.join(projectRoot, ".env.local"));
const SUPABASE_URL = localEnv.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = localEnv.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    ".env.local must contain NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY",
  );
  process.exit(2);
}

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql:///ai_task_board?host=/var/run/postgresql";
const storageDir =
  process.env.LOCAL_STORAGE_DIR ?? "/var/lib/ai-task-board/storage";

// Durable tables in foreign-key order. Transient state (idempotency records,
// bridge runtime leases, history import requests) is deliberately excluded,
// and stale queued thread commands are dropped so an old queue item can never
// be executed against a device after the move.
const TABLES = [
  { name: "workspaces", remap: [] },
  { name: "workspace_members", remap: ["user_id"] },
  { name: "ai_connections", remap: ["created_by_user_id"] },
  { name: "ai_bridge_directories", remap: [] },
  { name: "ai_sessions", remap: [] },
  { name: "tasks", remap: ["created_by_id"], order: "created_at.asc,id.asc" },
  { name: "task_dependencies", remap: [] },
  { name: "task_messages", remap: ["sender_id"], order: "created_at.asc,id.asc" },
  { name: "task_events", remap: ["actor_id"], order: "id.asc", identity: true },
  { name: "artifacts", remap: [] },
  {
    name: "session_activities",
    remap: [],
    order: "id.asc",
    identity: true,
  },
  { name: "session_history_syncs", remap: [] },
  { name: "ai_connection_bridge_settings", remap: [] },
  { name: "planning_notes", remap: ["updated_by"] },
  { name: "thread_planning_notes", remap: ["updated_by"] },
  { name: "session_turn_plans", remap: ["created_by"] },
  { name: "user_thread_view_state", remap: ["user_id"] },
  { name: "task_user_input_requests", remap: ["answered_by_user_id"] },
  {
    name: "ai_thread_commands",
    remap: ["requested_by_user_id"],
    filter: (row) => row.status !== "queued",
  },
  { name: "ai_file_commands", remap: ["requested_by_user_id"] },
];

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    ...extra,
  };
}

async function fetchTable(table, order) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const query = new URLSearchParams({ select: "*" });
    if (order) query.set("order", order);
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query.toString()}`;
    const response = await fetch(url, {
      headers: supabaseHeaders({ Range: `${from}-${from + pageSize - 1}` }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`${table} fetch failed (${response.status}): ${body.slice(0, 300)}`);
    }
    const chunk = await response.json();
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function insertRows(client, table, rows, options) {
  const { remap = [], filter, identity = false, userMap } = options;
  const prepared = rows.filter(filter ?? (() => true)).map((row) => {
    const next = { ...row };
    for (const column of remap) {
      const value = next[column];
      if (typeof value === "string" && userMap.has(value)) {
        next[column] = userMap.get(value);
      }
    }
    return next;
  });
  if (!prepared.length) return { fetched: rows.length, inserted: 0 };

  let inserted = 0;
  const batchSize = 1000;
  for (let start = 0; start < prepared.length; start += batchSize) {
    const batch = prepared.slice(start, start + batchSize);
    const overriding = identity ? " OVERRIDING SYSTEM VALUE" : "";
    const result = await client.query(
      `insert into public."${table}"${overriding}
       select * from jsonb_populate_recordset(null::public."${table}", $1::jsonb)
       on conflict do nothing`,
      [JSON.stringify(batch)],
    );
    inserted += result.rowCount ?? 0;
  }
  return { fetched: rows.length, inserted };
}

async function migrateStorage() {
  const listPrefix = async (prefix) =>
    fetchJson(`${SUPABASE_URL}/storage/v1/object/list/task-artifacts`, {
      method: "POST",
      headers: supabaseHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        prefix,
        limit: 1000,
        offset: 0,
        sortBy: { column: "name", order: "asc" },
      }),
    });

  // The hosted list endpoint is non-recursive: folders have null metadata,
  // files carry metadata. Walk every folder to collect full object paths.
  const collectFiles = async (prefix) => {
    const files = [];
    for (const item of await listPrefix(prefix)) {
      if (item.metadata === null || item.metadata === undefined) {
        files.push(...(await collectFiles(`${prefix}${item.name}/`)));
      } else {
        files.push(`${prefix}${item.name}`);
      }
    }
    return files;
  };
  const files = await collectFiles("");

  let downloaded = 0;
  for (const name of files) {
    const encoded = name
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const response = await fetch(
      `${SUPABASE_URL}/storage/v1/object/task-artifacts/${encoded}`,
      { headers: supabaseHeaders() },
    );
    if (!response.ok) {
      console.warn(`  ! storage object ${name}: HTTP ${response.status}`);
      continue;
    }
    const target = path.join(storageDir, "task-artifacts", name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    downloaded += 1;
  }
  console.log(`storage objects downloaded: ${downloaded}/${files.length}`);
}

const client = new Client({ connectionString });
await client.connect();
try {
  const hostedUsers = (
    await fetchJson(`${SUPABASE_URL}/auth/v1/admin/users`, {
      headers: supabaseHeaders(),
    })
  ).users ?? [];
  const localUsers = await client.query(
    `select id, lower(email) as email from auth.users`,
  );
  const localByEmail = new Map(
    localUsers.rows.map((row) => [row.email, row.id]),
  );
  const userMap = new Map();
  const missing = [];
  for (const user of hostedUsers) {
    const localId = localByEmail.get((user.email ?? "").toLowerCase());
    if (localId) userMap.set(user.id, localId);
    else missing.push(user.email);
  }
  if (missing.length) {
    throw new Error(
      `hosted users without a local account (create them first): ${missing.join(", ")}`,
    );
  }
  console.log(`auth user mapping: ${userMap.size} id(s)`);

  const summary = [];
  const sessionTaskRefs = new Map();
  for (const table of TABLES) {
    await client.query("begin");
    try {
      if (table.name === "tasks") {
        // Imported sessions have stale heartbeats; the directed-assignment
        // guard would reject every historical user task. It only exists to
        // police live Web writes, so bypass it while restoring history.
        await client.query(
          `alter table public.tasks disable trigger tasks_directed_assignment_guard`,
        );
      }
      let rows = await fetchTable(table.name, table.order);
      if (table.name === "ai_sessions") {
        // Sessions reference tasks (current/last completed) while tasks also
        // reference sessions: import sessions without those two columns and
        // restore them after the tasks table has landed.
        rows = rows.map((row) => {
          sessionTaskRefs.set(row.id, {
            current_task_id: row.current_task_id ?? null,
            last_completed_task_id: row.last_completed_task_id ?? null,
          });
          const { current_task_id, last_completed_task_id, ...rest } = row;
          return rest;
        });
      }
      const { fetched, inserted } = await insertRows(client, table.name, rows, {
        remap: table.remap,
        filter: table.filter,
        identity: table.identity,
        userMap,
      });
      await client.query("commit");
      if (table.name === "tasks") {
        await client.query(
          `alter table public.tasks enable trigger tasks_directed_assignment_guard`,
        );
      }
      summary.push({ table: table.name, fetched, inserted });
      console.log(
        `${table.name.padEnd(34)} fetched=${String(fetched).padStart(5)} inserted=${inserted}`,
      );
    } catch (error) {
      await client.query("rollback");
      if (table.name === "tasks") {
        await client.query(
          `alter table public.tasks enable trigger tasks_directed_assignment_guard`,
        ).catch(() => undefined);
      }
      throw new Error(`${table.name}: ${error.message}`);
    }
  }

  for (const [sessionId, refs] of sessionTaskRefs) {
    await client.query(
      `update public.ai_sessions
       set current_task_id = $2::uuid,
           last_completed_task_id = $3::uuid
       where id = $1::uuid`,
      [sessionId, refs.current_task_id, refs.last_completed_task_id],
    );
  }
  console.log(`session task references restored: ${sessionTaskRefs.size}`);

  // OVERRIDING SYSTEM VALUE does not advance identity sequences.
  for (const table of ["task_events", "session_activities"]) {
    await client.query(
      `select setval(
         pg_get_serial_sequence('public.${table}', 'id'),
         coalesce((select max(id) from public.${table}), 1),
         (select exists(select 1 from public.${table}))
       )`,
    );
  }

  try {
    await migrateStorage();
  } catch (error) {
    console.warn(`storage migration skipped: ${error.message}`);
  }

  console.log("\nmigration summary:");
  for (const row of summary) {
    console.log(`  ${row.table}: ${row.inserted}/${row.fetched} rows`);
  }
} finally {
  await client.end();
}

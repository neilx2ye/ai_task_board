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
];
const historyMigration = "20260810170000_codex_history_sync.sql";

type ImportResponse = {
  imported: { inserted: number; replayed: number };
  history_sync: {
    status: string;
    turn_limit: number;
    scanned_turns: number;
    imported_items: number;
  };
};

describe("Codex history sync migration", () => {
  let database: PGlite;
  const userId = randomUUID();
  const connectionId = randomUUID();
  const sessionId = randomUUID();
  const runtimeId = randomUUID();
  const tokenHash = randomUUID().replaceAll("-", "").repeat(2);
  const threadId = "codex-thread-history-1";
  let workspaceId: string;
  let liveActivityId: string;
  let historyReportSequence = 0;

  const exchange = async (
    sequence: number,
    effective: Record<string, unknown>,
    constraints: Record<string, unknown>,
  ) => {
    await database.query(
      `select public.exchange_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::bigint,
         60, false, 2, $6::jsonb, $7::jsonb, null
       )`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        runtimeId,
        sequence,
        JSON.stringify(effective),
        JSON.stringify(constraints),
      ],
    );
  };

  const importHistory = async ({
    items,
    status = "complete",
    runtimeInstanceId = runtimeId,
    turnLimit = 50,
    reportSequence,
    targetSessionId = sessionId,
  }: {
    items: unknown[];
    status?: "syncing" | "partial" | "complete" | "failed";
    runtimeInstanceId?: string;
    turnLimit?: number;
    reportSequence?: number;
    targetSessionId?: string;
  }) => {
    const effectiveReportSequence =
      reportSequence ?? ++historyReportSequence;
    historyReportSequence = Math.max(
      historyReportSequence,
      effectiveReportSequence,
    );
    const result = await database.query<{ response: ImportResponse }>(
      `select public.import_session_history(
         $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid,
         $6::bigint, $7::jsonb, $8::jsonb
       ) as response`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        targetSessionId,
        runtimeInstanceId,
        effectiveReportSequence,
        JSON.stringify(items),
        JSON.stringify({
          status,
          turn_limit: turnLimit,
          scanned_turns: 1,
          total_turns: 1,
          next_cursor: status === "complete" ? null : "older-page",
          error: status === "failed" ? "source failed" : null,
        }),
      ],
    );
    return result.rows[0].response;
  };

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
      [userId, `history-${userId}@example.invalid`],
    );
    const membership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [userId],
    );
    workspaceId = membership.rows[0].workspace_id;
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, created_by_user_id
       ) values ($1::uuid, $2::uuid, 'History Bridge', 'codex', $3, $4::uuid)`,
      [connectionId, workspaceId, tokenHash, userId],
    );
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform,
         external_conversation_ref, inventory_active, status
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'History thread', 'codex',
         $4, true, 'online'
       )`,
      [sessionId, workspaceId, connectionId, threadId],
    );
    const liveActivity = await database.query<{ id: string }>(
      `insert into public.session_activities (
         workspace_id, session_id, kind, actor_type, content, external_ref
       ) values ($1::uuid, $2::uuid, 'status', 'ai', 'live', 'live:1')
       returning id::text`,
      [workspaceId, sessionId],
    );
    liveActivityId = liveActivity.rows[0].id;

    const migration = await readFile(
      path.join(migrationsDirectory, historyMigration),
      "utf8",
    );
    await database.exec(migration);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("backfills timeline ordering and fail-closed history defaults", async () => {
    const activity = await database.query<{
      occurred_matches: boolean;
      source_order: string;
      source: string;
    }>(
      `select occurred_at = created_at as occurred_matches,
              source_order::text, source
       from public.session_activities where id = $1::bigint`,
      [liveActivityId],
    );
    expect(activity.rows[0]).toEqual({
      occurred_matches: true,
      source_order: liveActivityId,
      source: "live",
    });

    const settings = await database.query<{
      desired_sync_history: boolean;
      desired_history_turn_limit: number;
    }>(
      `select desired_sync_history, desired_history_turn_limit
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(settings.rows[0]).toEqual({
      desired_sync_history: false,
      desired_history_turn_limit: 50,
    });
  });

  it("accepts legacy reports fail-closed, then enables an explicit 0.4 gate", async () => {
    const update = await database.query<{
      response: { configuration: { version: number; desired: unknown } };
    }>(
      `select public.update_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::uuid, 1,
         true, true, 50, 2, true, 50,
         'history/config/1', repeat('a', 64)
       ) as response`,
      [workspaceId, userId, connectionId],
    );
    expect(update.rows[0].response.configuration).toMatchObject({
      version: 2,
      desired: { sync_history: true, history_turn_limit: 50 },
    });
    const legacyEffective = {
      enabled: true,
      include_thread_titles: true,
      max_threads: 50,
      max_concurrent_turns: 2,
    };
    const legacyConstraints = {
      remote_configuration_enabled: true,
      allow_thread_titles: true,
      max_threads: 50,
      max_concurrent_turns: 2,
      thread_scope: "cwd",
      working_directory: "/srv/board",
      fixed_thread: false,
      permission_mode: "safe",
      approval_mode: "decline",
    };
    await exchange(1, legacyEffective, legacyConstraints);
    const legacy = await database.query<{
      effective_sync_history: boolean;
      constraint_allow_history_sync: boolean;
    }>(
      `select effective_sync_history, constraint_allow_history_sync
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(legacy.rows[0]).toEqual({
      effective_sync_history: false,
      constraint_allow_history_sync: false,
    });
    await expect(importHistory({ items: [] })).rejects.toThrow(
      "HISTORY_SYNC_NOT_ALLOWED",
    );

    await exchange(
      2,
      {
        ...legacyEffective,
        sync_history: true,
        history_turn_limit: 50,
      },
      {
        ...legacyConstraints,
        allow_history_sync: true,
        max_history_turns: 200,
      },
    );

    // A duplicate/stale v3 sequence is a complete no-op. Its new 0.4-only
    // fields must not bypass that fence in the compatibility wrapper.
    await exchange(
      2,
      {
        ...legacyEffective,
        sync_history: false,
        history_turn_limit: 1,
      },
      {
        ...legacyConstraints,
        allow_history_sync: true,
        max_history_turns: 200,
      },
    );
    const staleReport = await database.query<{
      effective_sync_history: boolean;
      effective_history_turn_limit: number;
    }>(
      `select effective_sync_history, effective_history_turn_limit
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(staleReport.rows[0]).toEqual({
      effective_sync_history: true,
      effective_history_turn_limit: 50,
    });
  });

  it("keeps old sequence request identities after newer status reports", async () => {
    const ledgerSessionId = randomUUID();
    const ledgerThreadId = "codex-thread-history-ledger";
    await database.query(
      `insert into public.ai_sessions (
         id, workspace_id, connection_id, name, platform,
         external_conversation_ref, inventory_active, status
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'History ledger thread', 'codex',
         $4, true, 'online'
       )`,
      [ledgerSessionId, workspaceId, connectionId, ledgerThreadId],
    );

    const sequence10Item = {
      external_ref: `codex-history:${ledgerThreadId}:turn-ledger-10:item-ledger-10`,
      kind: "user_message",
      content: "Sequence ten",
      occurred_at: "2026-08-01T04:03:04.000Z",
      source_order: 30,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: ledgerThreadId,
        turn_id: "turn-ledger-10",
        item_id: "item-ledger-10",
      },
    };
    const sequence11Item = {
      external_ref: `codex-history:${ledgerThreadId}:turn-ledger-11:item-ledger-11`,
      kind: "assistant_message",
      content: "Sequence eleven",
      occurred_at: "2026-08-01T04:04:04.000Z",
      source_order: 31,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: ledgerThreadId,
        turn_id: "turn-ledger-11",
        item_id: "item-ledger-11",
      },
    };
    const conflictingItem = {
      external_ref: `codex-history:${ledgerThreadId}:turn-ledger-conflict:item-ledger-conflict`,
      kind: "assistant_message",
      content: "Must never be written",
      occurred_at: "2026-08-01T04:05:04.000Z",
      source_order: 32,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: ledgerThreadId,
        turn_id: "turn-ledger-conflict",
        item_id: "item-ledger-conflict",
      },
    };

    await importHistory({
      items: [sequence10Item],
      reportSequence: 10,
      targetSessionId: ledgerSessionId,
    });
    await importHistory({
      items: [sequence11Item],
      reportSequence: 11,
      targetSessionId: ledgerSessionId,
    });

    const oldReplay = await importHistory({
      items: [sequence10Item],
      reportSequence: 10,
      targetSessionId: ledgerSessionId,
    });
    expect(oldReplay.imported).toEqual({ inserted: 0, replayed: 1 });

    await expect(
      importHistory({
        items: [conflictingItem],
        reportSequence: 10,
        targetSessionId: ledgerSessionId,
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(
      importHistory({
        items: [],
        reportSequence: 10,
        targetSessionId: ledgerSessionId,
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");

    const afterConflicts = await database.query<{
      conflicting_rows: number;
      report_sequence: string;
      ledger_rows: number;
    }>(
      `select
         count(*) filter (
           where activity.external_ref = $2
         )::integer as conflicting_rows,
         (select report_sequence::text
          from public.session_history_syncs
          where session_id = $1::uuid) as report_sequence,
         (select count(*)::integer
          from public.session_history_import_requests
          where session_id = $1::uuid
            and runtime_instance_id = $3::uuid
            and report_sequence in (10, 11)) as ledger_rows
       from public.session_activities activity
       where activity.session_id = $1::uuid`,
      [ledgerSessionId, conflictingItem.external_ref, runtimeId],
    );
    expect(afterConflicts.rows[0]).toEqual({
      conflicting_rows: 0,
      report_sequence: "11",
      ledger_rows: 2,
    });
  });

  it("imports append-only rows, replays identically, and conflicts atomically", async () => {
    const item = {
      external_ref: `codex-history:${threadId}:turn-1:item-1`,
      kind: "user_message",
      content: "  Original question\n",
      occurred_at: "2026-08-01T02:03:04.000Z",
      source_order: 10,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: threadId,
        turn_id: "turn-1",
        item_id: "item-1",
      },
    };
    const first = await importHistory({ items: [item] });
    expect(first).toMatchObject({
      imported: { inserted: 1, replayed: 0 },
      history_sync: {
        status: "complete",
        imported_items: 1,
      },
    });
    expect(first.history_sync).not.toHaveProperty("workspace_id");
    expect(first.history_sync).not.toHaveProperty("session_id");
    expect(first.history_sync).not.toHaveProperty("runtime_instance_id");
    expect(first.history_sync).not.toHaveProperty("report_sequence");
    expect(first.history_sync).not.toHaveProperty("request_hash");

    const replay = await importHistory({ items: [item] });
    expect(replay.imported).toEqual({ inserted: 0, replayed: 1 });
    expect(replay.history_sync.imported_items).toBe(1);

    await expect(
      importHistory({
        items: [
          {
            ...item,
            external_ref: `codex-history:${threadId}:turn-2:item-2`,
            data: { ...item.data, turn_id: "turn-2", item_id: "item-2" },
          },
          { ...item, content: "Changed question" },
        ],
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");

    const rolledBack = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.session_activities
       where session_id = $1::uuid
         and external_ref = $2`,
      [sessionId, `codex-history:${threadId}:turn-2:item-2`],
    );
    expect(rolledBack.rows[0].count).toBe(0);

    const stored = await database.query<{
      count: number;
      task_id: string | null;
      task_message_id: string | null;
      source: string;
    }>(
      `select count(*)::integer as count, min(task_id::text) as task_id,
              min(task_message_id::text) as task_message_id,
              min(source) as source
       from public.session_activities
       where session_id = $1::uuid and source = 'codex_history'`,
      [sessionId],
    );
    expect(stored.rows[0]).toEqual({
      count: 1,
      task_id: null,
      task_message_id: null,
      source: "codex_history",
    });
    const content = await database.query<{ content: string }>(
      `select content from public.session_activities
       where session_id = $1::uuid and source = 'codex_history'`,
      [sessionId],
    );
    expect(content.rows[0].content).toBe(item.content);
  });

  it("accepts an empty status-only batch without inflating imported_items", async () => {
    const response = await importHistory({ items: [], status: "complete" });
    expect(response.imported).toEqual({ inserted: 0, replayed: 0 });
    expect(response.history_sync.imported_items).toBe(1);
  });

  it("rejects a non-owner runtime and a mismatched source thread", async () => {
    await expect(
      importHistory({ items: [], runtimeInstanceId: randomUUID() }),
    ).rejects.toThrow("BRIDGE_INSTANCE_CONFLICT");

    await expect(
      importHistory({
        items: [
          {
            external_ref: "codex-history:other:turn:item",
            kind: "assistant_message",
            content: "wrong thread",
            occurred_at: "2026-08-01T02:03:04.000Z",
            source_order: 1,
            data: {
              protocol: "codex-app-server/v1",
              thread_id: "another-thread",
              turn_id: "turn",
              item_id: "item",
            },
          },
        ],
      }),
    ).rejects.toThrow("INVALID_HISTORY_IMPORT");
  });

  it("does not let an in-flight old limit roll back a newer sync status", async () => {
    await database.query(
      `select public.update_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::uuid, 2,
         true, true, 50, 2, true, 100,
         'history/config/2', repeat('b', 64)
       )`,
      [workspaceId, userId, connectionId],
    );
    await database.query(
      `select public.exchange_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 3,
         60, false, 3,
         $5::jsonb, $6::jsonb, null
       )`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        runtimeId,
        JSON.stringify({
          enabled: true,
          include_thread_titles: true,
          max_threads: 50,
          max_concurrent_turns: 2,
          sync_history: true,
          history_turn_limit: 100,
        }),
        JSON.stringify({
          remote_configuration_enabled: true,
          allow_thread_titles: true,
          max_threads: 50,
          max_concurrent_turns: 2,
          thread_scope: "cwd",
          working_directory: "/srv/board",
          fixed_thread: false,
          permission_mode: "safe",
          approval_mode: "decline",
          allow_history_sync: true,
          max_history_turns: 200,
        }),
      ],
    );

    const current = await importHistory({ items: [], turnLimit: 100 });
    expect(current.history_sync.turn_limit).toBe(100);
    const acceptedSequence = historyReportSequence;

    await expect(
      importHistory({ items: [], turnLimit: 50 }),
    ).rejects.toThrow("HISTORY_SYNC_NOT_ALLOWED");
    const status = await database.query<{
      turn_limit: number;
      status: string;
    }>(
      `select turn_limit, status
       from public.session_history_syncs
       where session_id = $1::uuid`,
      [sessionId],
    );
    expect(status.rows[0]).toEqual({ turn_limit: 100, status: "complete" });

    const stale = await importHistory({
      items: [],
      status: "failed",
      turnLimit: 100,
      reportSequence: acceptedSequence - 1,
    });
    expect(stale.history_sync).toMatchObject({
      status: "complete",
      turn_limit: 100,
    });

    await expect(
      importHistory({
        items: [],
        status: "failed",
        turnLimit: 100,
        reportSequence: acceptedSequence,
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });

  it("serializes concurrent identical batches into one insert and one replay", async () => {
    const reportSequence = ++historyReportSequence;
    const concurrentItem = {
      external_ref: `codex-history:${threadId}:turn-concurrent:item-concurrent`,
      kind: "assistant_message",
      content: "Concurrent answer",
      occurred_at: "2026-08-01T03:03:04.000Z",
      source_order: 20,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: threadId,
        turn_id: "turn-concurrent",
        item_id: "item-concurrent",
      },
    };
    const results = await Promise.all([
      importHistory({
        items: [concurrentItem],
        turnLimit: 100,
        reportSequence,
      }),
      importHistory({
        items: [concurrentItem],
        turnLimit: 100,
        reportSequence,
      }),
    ]);
    expect(results.map((result) => result.imported)).toEqual(
      expect.arrayContaining([
        { inserted: 1, replayed: 0 },
        { inserted: 0, replayed: 1 },
      ]),
    );
    const stored = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.session_activities
       where session_id = $1::uuid and external_ref = $2`,
      [sessionId, concurrentItem.external_ref],
    );
    expect(stored.rows[0].count).toBe(1);

    const changedItem = {
      ...concurrentItem,
      external_ref: `codex-history:${threadId}:turn-concurrent:item-changed`,
      content: "Different payload under the same sequence",
      data: { ...concurrentItem.data, item_id: "item-changed" },
    };
    await expect(
      importHistory({
        items: [changedItem],
        turnLimit: 100,
        reportSequence,
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(
      importHistory({ items: [], turnLimit: 100, reportSequence }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const changedStored = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.session_activities
       where session_id = $1::uuid and external_ref = $2`,
      [sessionId, changedItem.external_ref],
    );
    expect(changedStored.rows[0].count).toBe(0);
  });

  it("lets the current leased runtime start a new status generation", async () => {
    const nextRuntimeId = randomUUID();
    await database.query(
      `update public.ai_connection_bridge_settings
       set active_runtime_lease_expires_at = clock_timestamp() - interval '1 second'
       where connection_id = $1::uuid`,
      [connectionId],
    );
    await database.query(
      `select public.exchange_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 1,
         60, false, 3, $5::jsonb, $6::jsonb, null
       )`,
      [
        workspaceId,
        connectionId,
        tokenHash,
        nextRuntimeId,
        JSON.stringify({
          enabled: true,
          include_thread_titles: true,
          max_threads: 50,
          max_concurrent_turns: 2,
          sync_history: true,
          history_turn_limit: 100,
        }),
        JSON.stringify({
          remote_configuration_enabled: true,
          allow_thread_titles: true,
          max_threads: 50,
          max_concurrent_turns: 2,
          thread_scope: "cwd",
          working_directory: "/srv/board",
          fixed_thread: false,
          permission_mode: "safe",
          approval_mode: "decline",
          allow_history_sync: true,
          max_history_turns: 200,
        }),
      ],
    );

    const response = await importHistory({
      items: [],
      status: "syncing",
      runtimeInstanceId: nextRuntimeId,
      turnLimit: 100,
      reportSequence: 1,
    });
    expect(response.history_sync.status).toBe("syncing");
    const internal = await database.query<{
      runtime_instance_id: string;
      report_sequence: string;
    }>(
      `select runtime_instance_id::text, report_sequence::text
       from public.session_history_syncs
       where session_id = $1::uuid`,
      [sessionId],
    );
    expect(internal.rows[0]).toEqual({
      runtime_instance_id: nextRuntimeId,
      report_sequence: "1",
    });
  });

  it("keeps the import RPC service-role-only and status member-readable", async () => {
    const privileges = await database.query<{
      anon_execute: boolean;
      service_execute: boolean;
      authenticated_status_select: boolean;
      authenticated_runtime_select: boolean;
      authenticated_sequence_select: boolean;
      authenticated_hash_select: boolean;
      authenticated_insert: boolean;
      authenticated_ledger_select: boolean;
      authenticated_ledger_hash_select: boolean;
      authenticated_ledger_insert: boolean;
      service_ledger_insert: boolean;
      ledger_in_realtime: boolean;
    }>(`
      select
        has_function_privilege(
          'anon',
          'public.import_session_history(uuid,uuid,text,uuid,uuid,bigint,jsonb,jsonb)',
          'EXECUTE'
        ) as anon_execute,
        has_function_privilege(
          'service_role',
          'public.import_session_history(uuid,uuid,text,uuid,uuid,bigint,jsonb,jsonb)',
          'EXECUTE'
        ) as service_execute,
        has_column_privilege(
          'authenticated', 'public.session_history_syncs', 'status', 'SELECT'
        ) as authenticated_status_select,
        has_column_privilege(
          'authenticated', 'public.session_history_syncs',
          'runtime_instance_id', 'SELECT'
        ) as authenticated_runtime_select,
        has_column_privilege(
          'authenticated', 'public.session_history_syncs',
          'report_sequence', 'SELECT'
        ) as authenticated_sequence_select,
        has_column_privilege(
          'authenticated', 'public.session_history_syncs',
          'request_hash', 'SELECT'
        ) as authenticated_hash_select,
        has_table_privilege(
          'authenticated', 'public.session_history_syncs', 'INSERT'
        ) as authenticated_insert,
        has_table_privilege(
          'authenticated', 'public.session_history_import_requests', 'SELECT'
        ) as authenticated_ledger_select,
        has_column_privilege(
          'authenticated', 'public.session_history_import_requests',
          'request_hash', 'SELECT'
        ) as authenticated_ledger_hash_select,
        has_table_privilege(
          'authenticated', 'public.session_history_import_requests', 'INSERT'
        ) as authenticated_ledger_insert,
        has_table_privilege(
          'service_role', 'public.session_history_import_requests', 'INSERT'
        ) as service_ledger_insert,
        exists (
          select 1 from pg_publication_tables
          where schemaname = 'public'
            and tablename = 'session_history_import_requests'
        ) as ledger_in_realtime
    `);
    expect(privileges.rows[0]).toEqual({
      anon_execute: false,
      service_execute: true,
      authenticated_status_select: true,
      authenticated_runtime_select: false,
      authenticated_sequence_select: false,
      authenticated_hash_select: false,
      authenticated_insert: false,
      authenticated_ledger_select: false,
      authenticated_ledger_hash_select: false,
      authenticated_ledger_insert: false,
      service_ledger_insert: true,
      ledger_in_realtime: false,
    });
  });
});

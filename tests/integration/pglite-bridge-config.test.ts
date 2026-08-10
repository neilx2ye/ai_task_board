import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type BridgeConfigurationResponse = {
  configuration: {
    connection_id: string;
    version: number;
    desired: {
      enabled: boolean;
      include_thread_titles: boolean;
      max_threads: number;
      max_concurrent_turns: number;
    };
    applied: null | {
      version: number | null;
      effective: null | {
        enabled: boolean;
        include_thread_titles: boolean;
        max_threads: number;
        max_concurrent_turns: number;
      };
      constraints: Record<string, unknown>;
      error: string | null;
      applied_at: string;
    };
    runtime: {
      online: boolean;
      lease_expires_at: string | null;
    };
    updated_at: string;
  };
};

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
];
const bridgeConfigMigration =
  "20260810130000_bridge_remote_configuration.sql";

describe("Bridge remote configuration migration", () => {
  let database: PGlite;
  const userId = randomUUID();
  const connectionId = randomUUID();
  const tokenHash = randomUUID().repeat(2);
  let workspaceId: string;

  const updateConfiguration = async ({
    expectedVersion,
    idempotencyKey,
    requestHash,
  }: {
    expectedVersion: number;
    idempotencyKey: string;
    requestHash: string;
  }) => {
    const result = await database.query<{
      response: BridgeConfigurationResponse;
    }>(
      `select public.update_ai_connection_bridge_config(
         $1::uuid, $2::uuid, $3::uuid, $4::integer,
         false, true, 75, 4, $5::text, $6::text
       ) as response`,
      [
        workspaceId,
        userId,
        connectionId,
        expectedVersion,
        idempotencyKey,
        requestHash,
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
      [userId, `bridge-config-${userId}@example.invalid`],
    );
    const membership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [userId],
    );
    workspaceId = membership.rows[0].workspace_id;
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, created_by_user_id
       ) values (
         $1::uuid, $2::uuid, 'Pre-migration Bridge', 'codex', $3::text, $4::uuid
       )`,
      [connectionId, workspaceId, tokenHash, userId],
    );

    const migration = await readFile(
      path.join(migrationsDirectory, bridgeConfigMigration),
      "utf8",
    );
    await database.exec(migration);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("backfills defaults and creates settings for later connections", async () => {
    const backfilled = await database.query<{
      version: number;
      desired_enabled: boolean;
      desired_include_thread_titles: boolean;
      desired_max_threads: number;
      desired_max_concurrent_turns: number;
      applied_at: string | null;
    }>(
      `select version, desired_enabled, desired_include_thread_titles,
              desired_max_threads, desired_max_concurrent_turns,
              applied_at::text
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(backfilled.rows[0]).toEqual({
      version: 1,
      desired_enabled: true,
      desired_include_thread_titles: false,
      desired_max_threads: 50,
      desired_max_concurrent_turns: 2,
      applied_at: null,
    });

    const laterConnectionId = randomUUID();
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash
       ) values ($1::uuid, $2::uuid, 'Later Bridge', 'codex', $3::text)`,
      [laterConnectionId, workspaceId, randomUUID().repeat(2)],
    );
    const created = await database.query<{ count: number }>(
      `select count(*)::integer as count
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid and version = 1`,
      [laterConnectionId],
    );
    expect(created.rows[0].count).toBe(1);
  });

  it("replays a successful update before checking its stale expected version", async () => {
    const first = await updateConfiguration({
      expectedVersion: 1,
      idempotencyKey: "bridge-config/update/1",
      requestHash: "bridge-config-update-1".padEnd(64, "0"),
    });
    expect(first.configuration).toMatchObject({
      connection_id: connectionId,
      version: 2,
      desired: {
        enabled: false,
        include_thread_titles: true,
        max_threads: 75,
        max_concurrent_turns: 4,
      },
      applied: null,
    });
    expect(JSON.stringify(first)).not.toContain(tokenHash);
    expect(JSON.stringify(first)).not.toContain("api_token_hash");

    const replay = await updateConfiguration({
      expectedVersion: 1,
      idempotencyKey: "bridge-config/update/1",
      requestHash: "bridge-config-update-1".padEnd(64, "0"),
    });
    expect(replay).toEqual(first);

    await expect(
      updateConfiguration({
        expectedVersion: 1,
        idempotencyKey: "bridge-config/update/stale",
        requestHash: "bridge-config-update-stale".padEnd(64, "0"),
      }),
    ).rejects.toThrow("VERSION_CONFLICT");
  });

  it("reserves the idempotency row before taking the connection lock", async () => {
    const functionDefinition = await database.query<{ definition: string }>(`
      select pg_get_functiondef(
        'public.update_ai_connection_bridge_config(uuid,uuid,uuid,integer,boolean,boolean,integer,integer,text,text)'::regprocedure
      ) as definition
    `);
    const definition = functionDefinition.rows[0].definition;
    const idempotencyPosition = definition.indexOf("_idempotency_begin");
    const connectionLockPosition = definition.indexOf(
      "pg_advisory_xact_lock_shared",
    );

    expect(idempotencyPosition).toBeGreaterThan(-1);
    expect(connectionLockPosition).toBeGreaterThan(idempotencyPosition);
  });

  it("strictly validates and runtime-fences token-bound applied status", async () => {
    const constraints = {
      remote_configuration_enabled: true,
      allow_thread_titles: true,
      max_threads: 50,
      max_concurrent_turns: 3,
      thread_scope: "cwd",
      working_directory: "/srv/ai-task-board",
      fixed_thread: false,
      permission_mode: "safe",
      approval_mode: "decline",
    };
    const effective = {
      enabled: false,
      include_thread_titles: true,
      max_threads: 50,
      max_concurrent_turns: 3,
    };
    const runtimeA = randomUUID();
    const runtimeB = randomUUID();
    const runtimeC = randomUUID();
    const runtimeD = randomUUID();
    const runtimeE = randomUUID();

    const exchange = ({
      runtimeId = runtimeA,
      sequence = 1,
      leaseSeconds = 60,
      releaseRuntime = false,
      appliedVersion = 2,
      effectivePayload = effective as unknown,
      constraintsPayload = constraints as unknown,
      error = null as string | null,
      apiTokenHash = tokenHash,
    } = {}) =>
      database.query<{ response: BridgeConfigurationResponse }>(
        `select public.exchange_ai_connection_bridge_config(
           $1::uuid, $2::uuid, $3::text, $4::uuid, $5::bigint,
           $6::integer, $7::boolean, $8::integer,
           $9::jsonb, $10::jsonb, $11::text
         ) as response`,
        [
          workspaceId,
          connectionId,
          apiTokenHash,
          runtimeId,
          sequence,
          leaseSeconds,
          releaseRuntime,
          appliedVersion,
          JSON.stringify(effectivePayload),
          JSON.stringify(constraintsPayload),
          error,
        ],
      );

    await expect(
      exchange({ effectivePayload: { ...effective, unexpected: true } }),
    ).rejects.toThrow("INVALID_BRIDGE_CONFIG");

    await expect(
      exchange({ apiTokenHash: randomUUID().repeat(2) }),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    await expect(
      exchange({
        effectivePayload: { ...effective, max_threads: 51 },
      }),
    ).rejects.toThrow("INVALID_BRIDGE_CONFIG");
    await expect(
      exchange({
        constraintsPayload: { ...constraints, allow_thread_titles: false },
      }),
    ).rejects.toThrow("INVALID_BRIDGE_CONFIG");
    await expect(
      exchange({ leaseSeconds: 14 }),
    ).rejects.toThrow("INVALID_BRIDGE_CONFIG");

    const first = await exchange();
    expect(first.rows[0].response.configuration.applied).toMatchObject({
      version: 2,
      effective,
      constraints,
      error: null,
    });
    expect(first.rows[0].response.configuration.runtime).toMatchObject({
      online: true,
      lease_expires_at: expect.any(String),
    });
    const firstAppliedAt =
      first.rows[0].response.configuration.applied?.applied_at;
    expect(firstAppliedAt).toBeTypeOf("string");
    expect(JSON.stringify(first.rows[0].response)).not.toContain(tokenHash);

    const firstFence = await database.query<{
      active_runtime_instance_id: string;
      active_runtime_last_sequence: number;
      active_runtime_lease_expires_at: string;
    }>(
      `select active_runtime_instance_id, active_runtime_last_sequence,
              active_runtime_lease_expires_at::text
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(firstFence.rows[0]).toMatchObject({
      active_runtime_instance_id: runtimeA,
      active_runtime_last_sequence: 1,
    });

    const duplicate = await exchange({
      effectivePayload: { ...effective, max_threads: 40 },
    });
    expect(duplicate.rows[0].response.configuration.applied).toMatchObject({
      version: 2,
      effective,
    });
    expect(
      duplicate.rows[0].response.configuration.applied?.applied_at,
    ).toBe(firstAppliedAt);
    const duplicateFence = await database.query<{
      active_runtime_last_sequence: number;
      active_runtime_lease_expires_at: string;
    }>(
      `select active_runtime_last_sequence,
              active_runtime_lease_expires_at::text
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(duplicateFence.rows[0]).toEqual({
      active_runtime_last_sequence: 1,
      active_runtime_lease_expires_at:
        firstFence.rows[0].active_runtime_lease_expires_at,
    });

    const newerEffective = { ...effective, max_threads: 40 };
    const newer = await exchange({
      sequence: 2,
      effectivePayload: newerEffective,
    });
    expect(newer.rows[0].response.configuration.applied).toMatchObject({
      effective: newerEffective,
    });
    const stale = await exchange({ sequence: 1 });
    expect(stale.rows[0].response.configuration.applied).toEqual(
      newer.rows[0].response.configuration.applied,
    );

    await expect(
      exchange({ runtimeId: runtimeB, sequence: 1 }),
    ).rejects.toThrow("BRIDGE_INSTANCE_CONFLICT");
    await exchange({
      runtimeId: runtimeB,
      sequence: 1,
      releaseRuntime: true,
    });
    const fenceAfterOldRelease = await database.query<{
      active_runtime_instance_id: string;
      active_runtime_last_sequence: number;
    }>(
      `select active_runtime_instance_id, active_runtime_last_sequence
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(fenceAfterOldRelease.rows[0]).toEqual({
      active_runtime_instance_id: runtimeA,
      active_runtime_last_sequence: 2,
    });

    const released = await exchange({
      sequence: 3,
      releaseRuntime: true,
    });
    expect(released.rows[0].response.configuration.applied).toEqual(
      newer.rows[0].response.configuration.applied,
    );
    expect(released.rows[0].response.configuration.runtime.online).toBe(false);
    const releasedFence = await database.query<{
      active_runtime_instance_id: string | null;
      active_runtime_last_sequence: number | null;
      active_runtime_lease_expires_at: string | null;
    }>(
      `select active_runtime_instance_id, active_runtime_last_sequence,
              active_runtime_lease_expires_at::text
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(releasedFence.rows[0]).toEqual({
      active_runtime_instance_id: runtimeA,
      active_runtime_last_sequence: 3,
      active_runtime_lease_expires_at: expect.any(String),
    });
    expect(
      Date.parse(releasedFence.rows[0].active_runtime_lease_expires_at ?? ""),
    ).toBeLessThanOrEqual(Date.now());

    const lateBeforeRelease = await exchange({ sequence: 2 });
    expect(lateBeforeRelease.rows[0].response.configuration.applied).toEqual(
      released.rows[0].response.configuration.applied,
    );
    const releaseTombstone = await database.query<{
      active_runtime_instance_id: string;
      active_runtime_last_sequence: number;
    }>(
      `select active_runtime_instance_id, active_runtime_last_sequence
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(releaseTombstone.rows[0]).toEqual({
      active_runtime_instance_id: runtimeA,
      active_runtime_last_sequence: 3,
    });

    await exchange({ runtimeId: runtimeC, sequence: 1 });
    await exchange({
      runtimeId: runtimeA,
      sequence: 4,
      releaseRuntime: true,
    });
    const fenceAfterLateRelease = await database.query<{
      active_runtime_instance_id: string;
      active_runtime_last_sequence: number;
    }>(
      `select active_runtime_instance_id, active_runtime_last_sequence
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(fenceAfterLateRelease.rows[0]).toEqual({
      active_runtime_instance_id: runtimeC,
      active_runtime_last_sequence: 1,
    });
    await expect(
      exchange({ runtimeId: runtimeA, sequence: 4 }),
    ).rejects.toThrow("BRIDGE_INSTANCE_CONFLICT");

    await database.query(
      `update public.ai_connection_bridge_settings
       set active_runtime_lease_expires_at = now() - interval '1 second'
       where connection_id = $1::uuid`,
      [connectionId],
    );
    await exchange({ runtimeId: runtimeD, sequence: 1 });
    const takeover = await database.query<{
      active_runtime_instance_id: string;
      active_runtime_last_sequence: number;
    }>(
      `select active_runtime_instance_id, active_runtime_last_sequence
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(takeover.rows[0]).toEqual({
      active_runtime_instance_id: runtimeD,
      active_runtime_last_sequence: 1,
    });

    await expect(
      exchange({
        runtimeId: runtimeD,
        sequence: 2,
        appliedVersion: 3,
        effectivePayload: null,
        error: "future version",
      }),
    ).rejects.toThrow("INVALID_BRIDGE_CONFIG");

    const rotatedTokenHash = randomUUID().repeat(2);
    await database.query(
      `update public.ai_connections
       set api_token_hash = $2::text
       where id = $1::uuid`,
      [connectionId, rotatedTokenHash],
    );
    await expect(
      exchange({ runtimeId: runtimeD, sequence: 2 }),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");
    await exchange({
      runtimeId: runtimeE,
      sequence: 1,
      apiTokenHash: rotatedTokenHash,
    });
    const rotatedTakeover = await database.query<{
      active_runtime_instance_id: string;
      active_runtime_last_sequence: number;
    }>(
      `select active_runtime_instance_id, active_runtime_last_sequence
       from public.ai_connection_bridge_settings
       where connection_id = $1::uuid`,
      [connectionId],
    );
    expect(rotatedTakeover.rows[0]).toEqual({
      active_runtime_instance_id: runtimeE,
      active_runtime_last_sequence: 1,
    });
  });

  it("denies revoked/cross-workspace updates and exposes RPCs only to service_role", async () => {
    const otherUserId = randomUUID();
    await database.query(
      "insert into auth.users (id, email) values ($1::uuid, $2::text)",
      [otherUserId, `bridge-config-other-${otherUserId}@example.invalid`],
    );
    const otherMembership = await database.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_members where user_id = $1::uuid",
      [otherUserId],
    );
    const otherWorkspaceId = otherMembership.rows[0].workspace_id;

    await expect(
      database.query(
        `select public.update_ai_connection_bridge_config(
           $1::uuid, $2::uuid, $3::uuid, 2,
           true, false, 50, 2, $4::text, $5::text
         )`,
        [
          otherWorkspaceId,
          otherUserId,
          connectionId,
          "bridge-config/cross-workspace",
          "bridge-config-cross-workspace".padEnd(64, "0"),
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const revokedConnectionId = randomUUID();
    await database.query(
      `insert into public.ai_connections (
         id, workspace_id, name, platform, api_token_hash, revoked_at
       ) values ($1::uuid, $2::uuid, 'Revoked Bridge', 'codex', $3::text, now())`,
      [revokedConnectionId, workspaceId, randomUUID().repeat(2)],
    );
    await expect(
      database.query(
        `select public.update_ai_connection_bridge_config(
           $1::uuid, $2::uuid, $3::uuid, 1,
           true, false, 50, 2, $4::text, $5::text
         )`,
        [
          workspaceId,
          userId,
          revokedConnectionId,
          "bridge-config/revoked",
          "bridge-config-revoked".padEnd(64, "0"),
        ],
      ),
    ).rejects.toThrow("SESSION_NOT_AUTHORIZED");

    const privileges = await database.query<{
      authenticated_update: boolean;
      authenticated_exchange: boolean;
      service_update: boolean;
      service_exchange: boolean;
    }>(`
      select
        has_function_privilege(
          'authenticated',
          'public.update_ai_connection_bridge_config(uuid,uuid,uuid,integer,boolean,boolean,integer,integer,text,text)',
          'EXECUTE'
        ) as authenticated_update,
        has_function_privilege(
          'authenticated',
          'public.exchange_ai_connection_bridge_config(uuid,uuid,text,uuid,bigint,integer,boolean,integer,jsonb,jsonb,text)',
          'EXECUTE'
        ) as authenticated_exchange,
        has_function_privilege(
          'service_role',
          'public.update_ai_connection_bridge_config(uuid,uuid,uuid,integer,boolean,boolean,integer,integer,text,text)',
          'EXECUTE'
        ) as service_update,
        has_function_privilege(
          'service_role',
          'public.exchange_ai_connection_bridge_config(uuid,uuid,text,uuid,bigint,integer,boolean,integer,jsonb,jsonb,text)',
          'EXECUTE'
        ) as service_exchange
    `);
    expect(privileges.rows[0]).toEqual({
      authenticated_update: false,
      authenticated_exchange: false,
      service_update: true,
      service_exchange: true,
    });
  });
});

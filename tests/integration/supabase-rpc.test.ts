import { createHash, randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.RUN_HOSTED_INTEGRATION_TESTS === "1";
const hostedDescribe = enabled ? describe : describe.skip;

type Fixture = {
  workspaceId: string;
  connectionId: string;
  sessionIds: string[];
};

type RpcTask = Record<string, unknown> & {
  id: string;
  status: string;
};

let admin: SupabaseClient;
const workspaceIds = new Set<string>();
const authUserIds = new Set<string>();
const connectionTokenHashes = new Map<string, string>();

const AI_RPC_NAMES = new Set([
  "register_ai_session",
  "sync_ai_sessions",
  "report_current_task",
  "claim_next_task",
  "claim_task",
  "create_subtasks",
  "heartbeat_claim",
  "heartbeat_ai_session",
  "request_user_input",
  "complete_task_and_claim_next",
  "report_progress",
  "post_task_message",
  "complete_task",
  "fail_task",
  "release_task",
]);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function key(step: string): string {
  return `integration/${step}/${randomUUID()}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rpcTask(data: unknown, field = "task"): RpcTask | null {
  const root = asRecord(data, "RPC response");
  if (root[field] === null) return null;
  const task = asRecord(root[field], `RPC response.${field}`);
  if (typeof task.id !== "string" || typeof task.status !== "string") {
    throw new Error(`RPC response.${field} is not a task`);
  }
  return task as RpcTask;
}

async function createFixture(
  sessionCount = 2,
  workspaceId: string = randomUUID(),
): Promise<Fixture> {
  const connectionId = randomUUID();
  const apiTokenHash = digest(`connection:${connectionId}`);
  const sessionIds = Array.from({ length: sessionCount }, () => randomUUID());

  const { error: workspaceError } = await admin.from("workspaces").insert({
    id: workspaceId,
    name: `Integration ${workspaceId.slice(0, 8)}`,
  });
  if (workspaceError && workspaceError.code !== "23505") throw workspaceError;
  workspaceIds.add(workspaceId);

  const { error: connectionError } = await admin.from("ai_connections").insert({
    id: connectionId,
    workspace_id: workspaceId,
    name: "Integration connection",
    platform: "test",
    api_token_hash: apiTokenHash,
  });
  if (connectionError) throw connectionError;
  connectionTokenHashes.set(connectionId, apiTokenHash);

  const { error: sessionsError } = await admin.from("ai_sessions").insert(
    sessionIds.map((id, index) => ({
      id,
      workspace_id: workspaceId,
      connection_id: connectionId,
      name: `Integration session ${index + 1}`,
      platform: "test",
      model: "deterministic-test-double",
      capabilities: ["analysis", "writing", "web-research"],
      status: "online",
    })),
  );
  if (sessionsError) throw sessionsError;

  return { workspaceId, connectionId, sessionIds };
}

async function createReadyTask(
  workspaceId: string,
  title: string,
  assignedSessionId?: string,
): Promise<string> {
  const taskId = randomUUID();
  const { error } = await admin.from("tasks").insert({
    id: taskId,
    workspace_id: workspaceId,
    root_task_id: taskId,
    title,
    status: "ready",
    priority: 50,
    assigned_session_id: assignedSessionId ?? null,
    required_capabilities: ["analysis"],
    created_by_type: "system",
  });
  if (error) throw error;
  return taskId;
}

async function createConnectionSession(
  workspaceId: string,
  label: string,
): Promise<{ connectionId: string; sessionId: string }> {
  const connectionId = randomUUID();
  const apiTokenHash = digest(`connection:${connectionId}`);
  const sessionId = randomUUID();
  const { error: connectionError } = await admin.from("ai_connections").insert({
    id: connectionId,
    workspace_id: workspaceId,
    name: `Integration connection ${label}`,
    platform: "test",
    api_token_hash: apiTokenHash,
  });
  if (connectionError) throw connectionError;
  connectionTokenHashes.set(connectionId, apiTokenHash);

  const { error: sessionError } = await admin.from("ai_sessions").insert({
    id: sessionId,
    workspace_id: workspaceId,
    connection_id: connectionId,
    name: `Integration session ${label}`,
    platform: "test",
    model: "deterministic-test-double",
    capabilities: ["analysis", "writing", "web-research"],
    status: "online",
  });
  if (sessionError) throw sessionError;
  return { connectionId, sessionId };
}

async function rpc(name: string, parameters: Record<string, unknown>) {
  if (!AI_RPC_NAMES.has(name)) return admin.rpc(name, parameters);
  const connectionId = parameters.p_connection_id;
  if (typeof connectionId !== "string") {
    throw new Error(`${name} requires p_connection_id in the integration fixture`);
  }
  const apiTokenHash = connectionTokenHashes.get(connectionId);
  if (!apiTokenHash) {
    throw new Error(`No API token hash is registered for connection ${connectionId}`);
  }
  return admin.rpc(name, { ...parameters, p_api_token_hash: apiTokenHash });
}

hostedDescribe("Supabase Hosted RPC integration", () => {
  beforeAll(() => {
    const url = process.env.TEST_SUPABASE_URL?.trim();
    const secret = process.env.TEST_SUPABASE_SECRET_KEY?.trim();
    if (!url || !secret) {
      throw new Error(
        "RUN_HOSTED_INTEGRATION_TESTS=1 requires TEST_SUPABASE_URL and TEST_SUPABASE_SECRET_KEY",
      );
    }
    admin = createClient(url, secret, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  afterAll(async () => {
    if (!admin) return;
    for (const workspaceId of workspaceIds) {
      const { error } = await admin.from("workspaces").delete().eq("id", workspaceId);
      if (error) throw error;
    }
    for (const userId of authUserIds) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
    }
  });

  it("only lets the designated session receive and recover its reserved task", async () => {
    const fixture = await createFixture(2);
    const winnerSessionId = fixture.sessionIds[0];
    const loserSessionId = fixture.sessionIds[1];
    const taskId = await createReadyTask(
      fixture.workspaceId,
      "Directed claim target",
      winnerSessionId,
    );
    const claimHashes = fixture.sessionIds.map((sessionId) => digest(`claim:${sessionId}`));

    const attempts = await Promise.all(
      fixture.sessionIds.map((sessionId, index) =>
        rpc("claim_next_task", {
          p_workspace_id: fixture.workspaceId,
          p_connection_id: fixture.connectionId,
          p_session_id: sessionId,
          p_claim_token_hash: claimHashes[index],
          p_lease_seconds: 900,
          p_idempotency_key: key(`concurrent-claim-${index}`),
          p_request_hash: digest(`concurrent-claim-${index}`),
        }),
      ),
    );
    attempts.forEach(({ error }) => expect(error).toBeNull());

    const claimed = attempts
      .map(({ data }, index) => ({ task: rpcTask(data), index }))
      .filter((result): result is { task: RpcTask; index: number } => result.task !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].task.id).toBe(taskId);
    expect(claimed[0].index).toBe(0);
    const winnerIndex = 0;

    const heartbeat = await rpc("heartbeat_claim", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: winnerSessionId,
      p_task_id: taskId,
      p_claim_token_hash: claimHashes[winnerIndex],
      p_lease_seconds: 1200,
      p_idempotency_key: key("heartbeat"),
      p_request_hash: digest("heartbeat"),
    });
    expect(heartbeat.error).toBeNull();
    expect(new Date(String(rpcTask(heartbeat.data)?.lease_expires_at)).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const originalApiTokenHash = connectionTokenHashes.get(fixture.connectionId);
    if (!originalApiTokenHash) throw new Error("Fixture API token hash is missing");
    const rotatedApiTokenHash = digest(`rotated:${fixture.connectionId}`);
    const { error: rotateHashError } = await admin
      .from("ai_connections")
      .update({ api_token_hash: rotatedApiTokenHash })
      .eq("id", fixture.connectionId);
    if (rotateHashError) throw rotateHashError;

    const staleTokenHeartbeat = await admin.rpc("heartbeat_claim", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_api_token_hash: originalApiTokenHash,
      p_session_id: winnerSessionId,
      p_task_id: taskId,
      p_claim_token_hash: claimHashes[winnerIndex],
      p_lease_seconds: 900,
      p_idempotency_key: key("heartbeat-after-token-rotation-old"),
      p_request_hash: digest("heartbeat-after-token-rotation-old"),
    });
    expect(staleTokenHeartbeat.error?.message).toContain("SESSION_NOT_AUTHORIZED");

    const rotatedTokenHeartbeat = await admin.rpc("heartbeat_claim", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_api_token_hash: rotatedApiTokenHash,
      p_session_id: winnerSessionId,
      p_task_id: taskId,
      p_claim_token_hash: claimHashes[winnerIndex],
      p_lease_seconds: 900,
      p_idempotency_key: key("heartbeat-after-token-rotation-new"),
      p_request_hash: digest("heartbeat-after-token-rotation-new"),
    });
    expect(rotatedTokenHeartbeat.error).toBeNull();
    connectionTokenHashes.set(fixture.connectionId, rotatedApiTokenHash);

    const { error: expireError } = await admin
      .from("tasks")
      .update({ lease_expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq("id", taskId);
    if (expireError) throw expireError;

    const unauthorizedTakeover = await rpc("claim_next_task", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: loserSessionId,
      p_claim_token_hash: digest(`takeover:${loserSessionId}`),
      p_lease_seconds: 900,
      p_idempotency_key: key("expired-takeover"),
      p_request_hash: digest("expired-takeover"),
    });
    expect(unauthorizedTakeover.error).toBeNull();
    expect(rpcTask(unauthorizedTakeover.data)).toBeNull();

    const recoveredClaimHash = digest(`recover:${winnerSessionId}`);
    const recovered = await rpc("claim_next_task", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: winnerSessionId,
      p_claim_token_hash: recoveredClaimHash,
      p_lease_seconds: 900,
      p_idempotency_key: key("assigned-session-recovers"),
      p_request_hash: digest("assigned-session-recovers"),
    });
    expect(recovered.error).toBeNull();
    expect(rpcTask(recovered.data)?.id).toBe(taskId);

    const staleUpdate = await rpc("report_progress", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: winnerSessionId,
      p_task_id: taskId,
      p_claim_token_hash: claimHashes[winnerIndex],
      p_progress_note: "This stale holder must be rejected",
      p_progress_percent_estimate: 50,
      p_idempotency_key: key("stale-progress"),
      p_request_hash: digest("stale-progress"),
    });
    expect(staleUpdate.error?.message).toContain("INVALID_CLAIM_TOKEN");
  });

  it("unblocks a shared dependent when two connections complete its prerequisites concurrently", async () => {
    const fixture = await createFixture(1);
    const firstActor = {
      connectionId: fixture.connectionId,
      sessionId: fixture.sessionIds[0],
    };
    const secondActor = await createConnectionSession(fixture.workspaceId, "concurrent-b");
    const firstTaskId = await createReadyTask(
      fixture.workspaceId,
      "Concurrent prerequisite A",
      firstActor.sessionId,
    );
    const secondTaskId = await createReadyTask(
      fixture.workspaceId,
      "Concurrent prerequisite B",
      secondActor.sessionId,
    );
    const dependentTaskId = randomUUID();
    const { error: dependentError } = await admin.from("tasks").insert({
      id: dependentTaskId,
      workspace_id: fixture.workspaceId,
      root_task_id: dependentTaskId,
      title: "Dependent on concurrent A and B",
      status: "blocked",
      priority: 40,
      assigned_session_id: firstActor.sessionId,
      required_capabilities: ["analysis"],
      created_by_type: "system",
    });
    if (dependentError) throw dependentError;
    const { error: dependenciesError } = await admin.from("task_dependencies").insert([
      { task_id: dependentTaskId, depends_on_task_id: firstTaskId },
      { task_id: dependentTaskId, depends_on_task_id: secondTaskId },
    ]);
    if (dependenciesError) throw dependenciesError;

    const firstClaimHash = digest(`concurrent-completion-a:${firstTaskId}`);
    const secondClaimHash = digest(`concurrent-completion-b:${secondTaskId}`);
    const claims = await Promise.all([
      rpc("claim_task", {
        p_workspace_id: fixture.workspaceId,
        p_connection_id: firstActor.connectionId,
        p_session_id: firstActor.sessionId,
        p_task_id: firstTaskId,
        p_claim_token_hash: firstClaimHash,
        p_lease_seconds: 900,
        p_idempotency_key: key("claim-concurrent-prerequisite-a"),
        p_request_hash: digest("claim-concurrent-prerequisite-a"),
      }),
      rpc("claim_task", {
        p_workspace_id: fixture.workspaceId,
        p_connection_id: secondActor.connectionId,
        p_session_id: secondActor.sessionId,
        p_task_id: secondTaskId,
        p_claim_token_hash: secondClaimHash,
        p_lease_seconds: 900,
        p_idempotency_key: key("claim-concurrent-prerequisite-b"),
        p_request_hash: digest("claim-concurrent-prerequisite-b"),
      }),
    ]);
    claims.forEach(({ error }) => expect(error).toBeNull());

    const completions = await Promise.all([
      rpc("complete_task", {
        p_workspace_id: fixture.workspaceId,
        p_connection_id: firstActor.connectionId,
        p_session_id: firstActor.sessionId,
        p_task_id: firstTaskId,
        p_claim_token_hash: firstClaimHash,
        p_result_summary: "Concurrent prerequisite A complete",
        p_result_json: { integration: true, prerequisite: "a" },
        p_message_content: null,
        p_artifacts: [],
        p_idempotency_key: key("complete-concurrent-prerequisite-a"),
        p_request_hash: digest("complete-concurrent-prerequisite-a"),
      }),
      rpc("complete_task", {
        p_workspace_id: fixture.workspaceId,
        p_connection_id: secondActor.connectionId,
        p_session_id: secondActor.sessionId,
        p_task_id: secondTaskId,
        p_claim_token_hash: secondClaimHash,
        p_result_summary: "Concurrent prerequisite B complete",
        p_result_json: { integration: true, prerequisite: "b" },
        p_message_content: null,
        p_artifacts: [],
        p_idempotency_key: key("complete-concurrent-prerequisite-b"),
        p_request_hash: digest("complete-concurrent-prerequisite-b"),
      }),
    ]);
    completions.forEach(({ error }) => expect(error).toBeNull());
    expect(completions.map(({ data }) => rpcTask(data)?.status)).toEqual([
      "completed",
      "completed",
    ]);

    const { data: dependent, error: dependentQueryError } = await admin
      .from("tasks")
      .select("id,status")
      .eq("id", dependentTaskId)
      .single();
    if (dependentQueryError) throw dependentQueryError;
    expect(dependent.status).toBe("ready");
  }, 30_000);

  it("unblocks a task after an aggregate completes and re-blocks it when a leaf is reopened", async () => {
    const suffix = randomUUID();
    const password = `Integration-${suffix}-Aa1!`;
    const { data: createdUser, error: createUserError } =
      await admin.auth.admin.createUser({
        email: `aggregate-${suffix}@example.invalid`,
        password,
        email_confirm: true,
      });
    if (createUserError) throw createUserError;
    authUserIds.add(createdUser.user.id);

    const { data: membership, error: membershipError } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", createdUser.user.id)
      .single();
    if (membershipError) throw membershipError;
    const workspaceId = String(membership.workspace_id);
    workspaceIds.add(workspaceId);
    const fixture = await createFixture(2, workspaceId);
    const workerSessionId = fixture.sessionIds[0];
    const downstreamSessionId = fixture.sessionIds[1];
    const parentTaskId = await createReadyTask(
      workspaceId,
      "Aggregate dependency parent",
      workerSessionId,
    );
    const parentClaimHash = digest(`aggregate-parent:${parentTaskId}`);

    const parentClaim = await rpc("claim_task", {
      p_workspace_id: workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: workerSessionId,
      p_task_id: parentTaskId,
      p_claim_token_hash: parentClaimHash,
      p_lease_seconds: 900,
      p_idempotency_key: key("claim-aggregate-parent"),
      p_request_hash: digest("claim-aggregate-parent"),
    });
    expect(parentClaim.error).toBeNull();

    const split = await rpc("create_subtasks", {
      p_workspace_id: workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: workerSessionId,
      p_parent_task_id: parentTaskId,
      p_claim_token_hash: parentClaimHash,
      p_subtasks: [
        { client_ref: "leaf-a", title: "Aggregate leaf A", position: 0, depends_on: [] },
        { client_ref: "leaf-b", title: "Aggregate leaf B", position: 1, depends_on: [] },
      ],
      p_idempotency_key: key("split-aggregate-parent"),
      p_request_hash: digest("split-aggregate-parent"),
    });
    expect(split.error).toBeNull();
    const splitTasks = asRecord(split.data, "aggregate split response").subtasks;
    if (!Array.isArray(splitTasks)) throw new Error("aggregate subtasks must be an array");
    const leafIds = splitTasks.map((task, index) =>
      String(asRecord(task, `aggregate leaf ${index}`).id),
    );
    expect(leafIds).toHaveLength(2);

    const downstreamTaskId = randomUUID();
    const { error: downstreamInsertError } = await admin.from("tasks").insert({
      id: downstreamTaskId,
      workspace_id: workspaceId,
      root_task_id: downstreamTaskId,
      title: "Depends on aggregate parent",
      status: "blocked",
      priority: 30,
      assigned_session_id: downstreamSessionId,
      required_capabilities: ["analysis"],
      created_by_type: "system",
    });
    if (downstreamInsertError) throw downstreamInsertError;
    const { error: downstreamDependencyError } = await admin
      .from("task_dependencies")
      .insert({ task_id: downstreamTaskId, depends_on_task_id: parentTaskId });
    if (downstreamDependencyError) throw downstreamDependencyError;

    const claimAndCompleteLeaf = async (leafId: string, step: string) => {
      const claimHash = digest(`${step}:${leafId}`);
      const claim = await rpc("claim_task", {
        p_workspace_id: workspaceId,
        p_connection_id: fixture.connectionId,
        p_session_id: workerSessionId,
        p_task_id: leafId,
        p_claim_token_hash: claimHash,
        p_lease_seconds: 900,
        p_idempotency_key: key(`${step}-claim`),
        p_request_hash: digest(`${step}-claim`),
      });
      expect(claim.error).toBeNull();
      const completion = await rpc("complete_task", {
        p_workspace_id: workspaceId,
        p_connection_id: fixture.connectionId,
        p_session_id: workerSessionId,
        p_task_id: leafId,
        p_claim_token_hash: claimHash,
        p_result_summary: `${step} complete`,
        p_result_json: { integration: true, step },
        p_message_content: null,
        p_artifacts: [],
        p_idempotency_key: key(`${step}-complete`),
        p_request_hash: digest(`${step}-complete`),
      });
      expect(completion.error).toBeNull();
      expect(rpcTask(completion.data)?.status).toBe("completed");
    };

    await claimAndCompleteLeaf(leafIds[0], "aggregate-leaf-a-first");
    const { data: beforeLastLeaf, error: beforeLastLeafError } = await admin
      .from("tasks")
      .select("id,status")
      .in("id", [parentTaskId, downstreamTaskId]);
    if (beforeLastLeafError) throw beforeLastLeafError;
    expect(beforeLastLeaf?.find((task) => task.id === parentTaskId)?.status).not.toBe(
      "completed",
    );
    expect(beforeLastLeaf?.find((task) => task.id === downstreamTaskId)?.status).toBe(
      "blocked",
    );

    await claimAndCompleteLeaf(leafIds[1], "aggregate-leaf-b");
    const { data: afterAggregateCompletion, error: afterAggregateCompletionError } =
      await admin
        .from("tasks")
        .select("id,status")
        .in("id", [parentTaskId, downstreamTaskId]);
    if (afterAggregateCompletionError) throw afterAggregateCompletionError;
    expect(
      afterAggregateCompletion?.find((task) => task.id === parentTaskId)?.status,
    ).toBe("completed");
    expect(
      afterAggregateCompletion?.find((task) => task.id === downstreamTaskId)?.status,
    ).toBe("ready");

    const reopen = await rpc("reopen_task", {
      p_workspace_id: workspaceId,
      p_user_id: createdUser.user.id,
      p_task_id: leafIds[0],
      p_reason: "Regression: aggregate dependency changed",
      p_idempotency_key: key("reopen-aggregate-leaf"),
      p_request_hash: digest("reopen-aggregate-leaf"),
    });
    expect(reopen.error).toBeNull();
    expect(rpcTask(reopen.data)?.status).toBe("ready");

    const { data: afterReopen, error: afterReopenError } = await admin
      .from("tasks")
      .select("id,status")
      .in("id", [leafIds[0], parentTaskId, downstreamTaskId]);
    if (afterReopenError) throw afterReopenError;
    expect(afterReopen?.find((task) => task.id === leafIds[0])?.status).toBe("ready");
    expect(afterReopen?.find((task) => task.id === parentTaskId)?.status).not.toBe(
      "completed",
    );
    expect(afterReopen?.find((task) => task.id === downstreamTaskId)?.status).toBe(
      "blocked",
    );

    // Restore the aggregate, claim its downstream task, then verify a second
    // reopen is rejected atomically because it would invalidate active work.
    await claimAndCompleteLeaf(leafIds[0], "aggregate-leaf-a-second");
    const downstreamClaimHash = digest(`aggregate-downstream:${downstreamTaskId}`);
    const downstreamClaim = await rpc("claim_task", {
      p_workspace_id: workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: downstreamSessionId,
      p_task_id: downstreamTaskId,
      p_claim_token_hash: downstreamClaimHash,
      p_lease_seconds: 900,
      p_idempotency_key: key("claim-aggregate-dependent"),
      p_request_hash: digest("claim-aggregate-dependent"),
    });
    expect(downstreamClaim.error).toBeNull();

    const rejectedReopen = await rpc("reopen_task", {
      p_workspace_id: workspaceId,
      p_user_id: createdUser.user.id,
      p_task_id: leafIds[0],
      p_reason: "Must roll back while dependent is active",
      p_idempotency_key: key("reject-reopen-with-active-dependent"),
      p_request_hash: digest("reject-reopen-with-active-dependent"),
    });
    expect(rejectedReopen.error?.message).toContain("INVALID_STATE_TRANSITION");

    const { data: rolledBackState, error: rolledBackStateError } = await admin
      .from("tasks")
      .select("id,status")
      .in("id", [leafIds[0], parentTaskId, downstreamTaskId]);
    if (rolledBackStateError) throw rolledBackStateError;
    expect(rolledBackState?.find((task) => task.id === leafIds[0])?.status).toBe(
      "completed",
    );
    expect(rolledBackState?.find((task) => task.id === parentTaskId)?.status).toBe(
      "completed",
    );
    expect(rolledBackState?.find((task) => task.id === downstreamTaskId)?.status).toBe(
      "claimed",
    );
  }, 60_000);

  it("rolls back cyclic decomposition and completes a valid chain transactionally", async () => {
    const fixture = await createFixture(1);
    const sessionId = fixture.sessionIds[0];
    const rootTaskId = await createReadyTask(
      fixture.workspaceId,
      "Decomposition root",
      sessionId,
    );
    const rootClaimHash = digest("decomposition-root-claim");

    const rootClaim = await rpc("claim_task", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: sessionId,
      p_task_id: rootTaskId,
      p_claim_token_hash: rootClaimHash,
      p_lease_seconds: 900,
      p_idempotency_key: key("claim-decomposition-root"),
      p_request_hash: digest("claim-decomposition-root"),
    });
    expect(rootClaim.error).toBeNull();

    const cyclic = await rpc("create_subtasks", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: sessionId,
      p_parent_task_id: rootTaskId,
      p_claim_token_hash: rootClaimHash,
      p_subtasks: [
        { client_ref: "a", title: "A", depends_on: ["b"] },
        { client_ref: "b", title: "B", depends_on: ["a"] },
      ],
      p_idempotency_key: key("cyclic-subtasks"),
      p_request_hash: digest("cyclic-subtasks"),
    });
    expect(cyclic.error?.message).toContain("DEPENDENCY_CYCLE");

    const { count: rolledBackChildren, error: countError } = await admin
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("parent_task_id", rootTaskId);
    if (countError) throw countError;
    expect(rolledBackChildren).toBe(0);

    const decomposition = await rpc("create_subtasks", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: sessionId,
      p_parent_task_id: rootTaskId,
      p_claim_token_hash: rootClaimHash,
      p_subtasks: [
        { client_ref: "first", title: "First leaf", position: 0, depends_on: [] },
        {
          client_ref: "second",
          title: "Second leaf",
          position: 1,
          depends_on: ["first"],
        },
      ],
      p_idempotency_key: key("valid-subtasks"),
      p_request_hash: digest("valid-subtasks"),
    });
    expect(decomposition.error).toBeNull();
    const subtaskData = asRecord(decomposition.data, "decomposition response").subtasks;
    expect(Array.isArray(subtaskData)).toBe(true);
    const subtasks = (subtaskData as unknown[]).map((task) => asRecord(task, "subtask"));

    const firstId = String(subtasks[0].id);
    const secondId = String(subtasks[1].id);
    const firstClaimHash = digest("first-leaf-claim");
    const firstClaim = await rpc("claim_task", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: sessionId,
      p_task_id: firstId,
      p_claim_token_hash: firstClaimHash,
      p_lease_seconds: 900,
      p_idempotency_key: key("claim-first-leaf"),
      p_request_hash: digest("claim-first-leaf"),
    });
    expect(firstClaim.error).toBeNull();

    const secondClaimHash = digest("second-leaf-next-claim");
    const completion = await rpc("complete_task_and_claim_next", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: sessionId,
      p_task_id: firstId,
      p_claim_token_hash: firstClaimHash,
      p_result_summary: "First complete",
      p_result_json: { integration: true },
      p_message_content: "Completed first leaf",
      p_artifacts: [],
      p_next_claim_token_hash: secondClaimHash,
      p_lease_seconds: 900,
      p_idempotency_key: key("complete-first-and-next"),
      p_request_hash: digest("complete-first-and-next"),
    });
    expect(completion.error).toBeNull();
    expect(rpcTask(completion.data, "next_task")?.id).toBe(secondId);

    const finalCompletion = await rpc("complete_task", {
      p_workspace_id: fixture.workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: sessionId,
      p_task_id: secondId,
      p_claim_token_hash: secondClaimHash,
      p_result_summary: "Second complete",
      p_result_json: { integration: true },
      p_message_content: "Completed second leaf",
      p_artifacts: [],
      p_idempotency_key: key("complete-second"),
      p_request_hash: digest("complete-second"),
    });
    expect(finalCompletion.error).toBeNull();

    const { data: finalTasks, error: finalQueryError } = await admin
      .from("tasks")
      .select("id,status")
      .in("id", [rootTaskId, firstId, secondId]);
    if (finalQueryError) throw finalQueryError;
    expect(finalTasks).toHaveLength(3);
    expect(finalTasks?.every((task) => task.status === "completed")).toBe(true);
  });

  it("deduplicates an external task, restores it after a user reply, and enforces RLS", async () => {
    const suffix = randomUUID();
    const password = `Integration-${suffix}-Aa1!`;
    const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
      email: `integration-${suffix}@example.invalid`,
      password,
      email_confirm: true,
    });
    if (createUserError) throw createUserError;
    authUserIds.add(createdUser.user.id);

    const { data: membership, error: membershipError } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", createdUser.user.id)
      .single();
    if (membershipError) throw membershipError;
    const workspaceId = String(membership.workspace_id);
    workspaceIds.add(workspaceId);
    const fixture = await createFixture(1, workspaceId);
    const sessionId = fixture.sessionIds[0];
    const externalRef = `external-${suffix}`;

    const report = (progress: number, step: string, claimHash: string) =>
      rpc("report_current_task", {
        p_workspace_id: workspaceId,
        p_connection_id: fixture.connectionId,
        p_session_id: sessionId,
        p_title: "Externally-started task",
        p_description: "Integration coverage",
        p_acceptance_criteria: "One card only",
        p_external_source: "integration",
        p_external_task_ref: externalRef,
        p_external_conversation_ref: `conversation-${suffix}`,
        p_priority: 10,
        p_progress_note: `${progress}% complete`,
        p_progress_percent_estimate: progress,
        p_required_capabilities: ["analysis"],
        p_claim_token_hash: claimHash,
        p_lease_seconds: 900,
        p_idempotency_key: key(step),
        p_request_hash: digest(step),
      });

    const firstClaimHash = digest("external-first-claim");
    const first = await report(20, "external-first", firstClaimHash);
    expect(first.error).toBeNull();
    const secondClaimHash = digest("external-second-claim");
    const second = await report(40, "external-second", secondClaimHash);
    expect(second.error).toBeNull();
    const taskId = rpcTask(first.data)?.id;
    if (!taskId) throw new Error("report_current_task did not return a task ID");
    expect(taskId).toBe(rpcTask(second.data)?.id);

    const { count, error: countError } = await admin
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("external_source", "integration")
      .eq("external_task_ref", externalRef);
    if (countError) throw countError;
    expect(count).toBe(1);

    const question = await rpc("request_user_input", {
      p_workspace_id: workspaceId,
      p_connection_id: fixture.connectionId,
      p_session_id: sessionId,
      p_task_id: taskId,
      p_claim_token_hash: secondClaimHash,
      p_question: "Which output format should be used?",
      p_idempotency_key: key("request-user-input"),
      p_request_hash: digest("request-user-input"),
    });
    expect(question.error).toBeNull();
    expect(rpcTask(question.data)?.status).toBe("waiting_user");

    const reply = await rpc("reply_to_task", {
      p_workspace_id: workspaceId,
      p_user_id: createdUser.user.id,
      p_task_id: taskId,
      p_content: "Use Markdown.",
      p_reply_to_message_id: null,
      p_idempotency_key: key("user-reply"),
      p_request_hash: digest("user-reply"),
    });
    expect(reply.error).toBeNull();
    expect(rpcTask(reply.data)?.status).toBe("ready");

    const publishableKey = process.env.TEST_SUPABASE_PUBLISHABLE_KEY?.trim();
    if (!publishableKey) {
      throw new Error(
        "RUN_HOSTED_INTEGRATION_TESTS=1 requires TEST_SUPABASE_PUBLISHABLE_KEY for RLS coverage",
      );
    }
    const userClient = createClient(process.env.TEST_SUPABASE_URL!, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await userClient.auth.signInWithPassword({
      email: `integration-${suffix}@example.invalid`,
      password,
    });
    if (signInError) throw signInError;

    const otherWorkspaceId = randomUUID();
    workspaceIds.add(otherWorkspaceId);
    const { error: otherWorkspaceError } = await admin
      .from("workspaces")
      .insert({ id: otherWorkspaceId, name: "RLS inaccessible workspace" });
    if (otherWorkspaceError) throw otherWorkspaceError;
    const hiddenTaskId = await createReadyTask(otherWorkspaceId, "Must stay hidden");

    const { data: leakedTasks, error: rlsError } = await userClient
      .from("tasks")
      .select("id")
      .eq("id", hiddenTaskId);
    if (rlsError) throw rlsError;
    expect(leakedTasks).toEqual([]);

    const storagePath = `${workspaceId}/${taskId}/${randomUUID()}-integration.txt`;
    const { error: uploadError } = await userClient.storage
      .from("task-artifacts")
      .upload(storagePath, new Blob(["private integration artifact"], { type: "text/plain" }));
    if (uploadError) throw uploadError;
    try {
      const anonymousClient = createClient(process.env.TEST_SUPABASE_URL!, publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const anonymousDownload = await anonymousClient.storage
        .from("task-artifacts")
        .download(storagePath);
      expect(anonymousDownload.data).toBeNull();
      expect(anonymousDownload.error).not.toBeNull();

      const { data: signed, error: signedError } = await admin.storage
        .from("task-artifacts")
        .createSignedUrl(storagePath, 60);
      if (signedError) throw signedError;
      const signedResponse = await fetch(signed.signedUrl);
      expect(signedResponse.ok).toBe(true);
      expect(await signedResponse.text()).toBe("private integration artifact");
    } finally {
      const { error: removeError } = await admin.storage
        .from("task-artifacts")
        .remove([storagePath]);
      if (removeError) throw removeError;
    }
  });
});

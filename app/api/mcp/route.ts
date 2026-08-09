import { NextResponse } from "next/server";
import { z, type ZodType } from "zod";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

import { authenticateAIRequest, authorizeAISession } from "@/lib/auth/ai-auth";
import { AppError, normalizeError } from "@/lib/domain/errors";
import { heartbeatSession, registerSession } from "@/lib/domain/sessions";
import {
  claimNextTask,
  claimTask,
  completeTask,
  completeTaskAndClaimNext,
  createSubtasks,
  failTask,
  getTask,
  getTaskUpdates,
  heartbeatClaim,
  postTaskMessage,
  releaseTask,
  reportCurrentTask,
  reportProgress,
  requestUserInput,
} from "@/lib/domain/tasks";
import type { AIAuthContext } from "@/lib/types/domain";
import {
  claimOptionsSchema,
  claimTaskSchema,
  completeAndClaimNextSchema,
  completeTaskSchema,
  createSubtasksSchema,
  failTaskSchema,
  heartbeatClaimSchema,
  postTaskMessageSchema,
  registerSessionSchema,
  releaseTaskSchema,
  reportCurrentTaskSchema,
  reportProgressSchema,
  requestUserInputSchema,
  sessionHeartbeatSchema,
} from "@/lib/validation/ai";
import { idempotencyKeySchema, uuidSchema } from "@/lib/validation/common";

const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const toolCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const metadataSchema = z
  .object({
    session_id: uuidSchema.optional(),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .catchall(z.unknown());

const getTaskToolSchema = z.object({ task_id: uuidSchema }).strict();
const getUpdatesToolSchema = z
  .object({
    task_id: uuidSchema,
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

const MCP_SERVER_INSTRUCTIONS = [
  "Per conversation or agent context, call register_session once and retain its session.id only there. Every 60s call heartbeat_session with session_id and a fresh idempotency_key; continue while idle or waiting for user input. While holding a task claim, also call heartbeat before lease expiry with task_id, current claim_token, and a fresh key; session heartbeat does not renew task leases. Stop session heartbeats only on explicit user request, MCP host/client close, or conversation end.",
  "Use a stable, unique external_conversation_ref when registering or resuming a conversation. Pass the returned session.id as arguments.session_id; never set a shared global X-AI-Session-ID for multiple conversations.",
  "Stop the task heartbeat when its claim ends through request_user_input, complete_task, complete_task_and_claim_next, fail_task, release_task, LEASE_EXPIRED, or INVALID_CLAIM_TOKEN, but keep heartbeat_session running while the conversation remains active. Before intentionally ending a conversation with unfinished claimed work, call release_task.",
  "If the host suspends execution and cannot call tools in the background, do not start an external daemon that outlives the conversation. When reactivated, call register_session with the same external_conversation_ref to restore the session and resume heartbeats. Reuse an idempotency_key only when retrying that same heartbeat tick.",
].join("\n\n");

type ToolDefinition = {
  name: string;
  description: string;
  schema: ZodType;
  readOnly?: boolean;
  requiresSession?: boolean;
};

const tools: ToolDefinition[] = [
  { name: "register_session", description: "Register or restore one session per distinct conversation. Save its session.id and start heartbeat_session at least every 60 seconds until stopped or the conversation ends.", schema: registerSessionSchema, requiresSession: false },
  { name: "report_current_task", description: "Idempotently sync work already running externally.", schema: reportCurrentTaskSchema },
  { name: "claim_next_task", description: "Receive the highest-priority executable task reserved for this session.", schema: claimOptionsSchema },
  { name: "claim_task", description: "Receive a specific executable task reserved for this session.", schema: claimTaskSchema },
  { name: "get_task", description: "Read a task and its related context.", schema: getTaskToolSchema, readOnly: true },
  { name: "create_subtasks", description: "Atomically decompose a claimed task into dependent subtasks.", schema: createSubtasksSchema },
  { name: "report_progress", description: "Report an estimate and progress note for a claimed task.", schema: reportProgressSchema },
  { name: "post_task_message", description: "Add a message to a task conversation.", schema: postTaskMessageSchema },
  { name: "request_user_input", description: "Ask the user a question and end the current lease.", schema: requestUserInputSchema },
  { name: "heartbeat_session", description: "Refresh AI session presence. Call at least every 60 seconds while the conversation is active, including while idle; this does not renew task claims.", schema: sessionHeartbeatSchema },
  { name: "heartbeat", description: "Extend a claimed task lease before expiry. Call this in addition to heartbeat_session while a task is held.", schema: heartbeatClaimSchema },
  { name: "complete_task", description: "Complete a claimed task with results and artifact references.", schema: completeTaskSchema },
  { name: "complete_task_and_claim_next", description: "Complete a task and atomically claim related follow-up work.", schema: completeAndClaimNextSchema },
  { name: "fail_task", description: "Mark a claimed task as failed and record the reason.", schema: failTaskSchema },
  { name: "release_task", description: "Release a claimed task back to the executable queue.", schema: releaseTaskSchema },
  { name: "get_task_updates", description: "Read events after an event cursor plus current messages and artifacts.", schema: getUpdatesToolSchema, readOnly: true },
];

function advertisedInputSchema(tool: ToolDefinition): Record<string, unknown> {
  const generated = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  const baseProperties =
    generated.properties && typeof generated.properties === "object"
      ? (generated.properties as Record<string, unknown>)
      : {};
  const properties: Record<string, unknown> = {
    ...baseProperties,
    ...(!tool.readOnly
      ? {
          idempotency_key: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Unique for this logical command; reuse only when retrying it.",
          },
        }
      : {}),
    ...(tool.requiresSession === false
      ? {}
      : {
          session_id: {
            type: "string",
            format: "uuid",
            description: "AI session ID; may be omitted when X-AI-Session-ID is configured.",
          },
        }),
  };
  const required = Array.isArray(generated.required)
    ? [...(generated.required as string[])]
    : [];
  if (!tool.readOnly && !required.includes("idempotency_key")) required.push("idempotency_key");
  return { ...generated, properties, required, additionalProperties: false };
}

function rpcResponse(id: string | number | null | undefined, result: unknown, status = 200) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { status, headers: noStoreHeaders },
  );
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  status: number,
  data?: unknown,
) {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    { status, headers: noStoreHeaders },
  );
}

function toolResult(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify({ data }) }],
    structuredContent: { data: data ?? null },
  };
}

function payloadWithoutMetadata(argumentsValue: Record<string, unknown>) {
  const payload = { ...argumentsValue };
  delete payload.session_id;
  delete payload.idempotency_key;
  return payload;
}

function idempotencyKey(request: Request, metadata: z.infer<typeof metadataSchema>): string {
  const value = request.headers.get("idempotency-key")?.trim() || metadata.idempotency_key;
  if (!value) throw new AppError("INVALID_REQUEST", "Idempotency-Key is required");
  return idempotencyKeySchema.parse(value);
}

async function toolSession(
  request: Request,
  auth: AIAuthContext,
  metadata: z.infer<typeof metadataSchema>,
) {
  const sessionId = request.headers.get("x-ai-session-id")?.trim() || metadata.session_id;
  if (!sessionId) throw new AppError("SESSION_NOT_AUTHORIZED", "AI session ID is required");
  return authorizeAISession(auth, uuidSchema.parse(sessionId));
}

async function executeTool(
  request: Request,
  auth: AIAuthContext,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  const metadata = metadataSchema.parse(argumentsValue);
  const payload = payloadWithoutMetadata(argumentsValue);
  if (name === "register_session") {
    return registerSession(
      auth,
      registerSessionSchema.parse(payload),
      idempotencyKey(request, metadata),
    );
  }

  const session = await toolSession(request, auth, metadata);
  if (name === "get_task") {
    const input = getTaskToolSchema.parse(payload);
    return getTask(session, input.task_id);
  }
  if (name === "get_task_updates") {
    const input = getUpdatesToolSchema.parse(payload);
    return getTaskUpdates(session, input.task_id, input.after, input.limit);
  }

  const key = idempotencyKey(request, metadata);
  switch (name) {
    case "report_current_task":
      return reportCurrentTask(session, reportCurrentTaskSchema.parse(payload), key);
    case "claim_next_task":
      return claimNextTask(session, claimOptionsSchema.parse(payload), key);
    case "claim_task":
      return claimTask(session, claimTaskSchema.parse(payload), key);
    case "create_subtasks":
      return createSubtasks(session, createSubtasksSchema.parse(payload), key);
    case "report_progress":
      return reportProgress(session, reportProgressSchema.parse(payload), key);
    case "post_task_message":
      return postTaskMessage(session, postTaskMessageSchema.parse(payload), key);
    case "request_user_input":
      return requestUserInput(session, requestUserInputSchema.parse(payload), key);
    case "heartbeat_session":
      return heartbeatSession(session, sessionHeartbeatSchema.parse(payload), key);
    case "heartbeat":
      return heartbeatClaim(session, heartbeatClaimSchema.parse(payload), key);
    case "complete_task":
      return completeTask(session, completeTaskSchema.parse(payload), key);
    case "complete_task_and_claim_next":
      return completeTaskAndClaimNext(session, completeAndClaimNextSchema.parse(payload), key);
    case "fail_task":
      return failTask(session, failTaskSchema.parse(payload), key);
    case "release_task":
      return releaseTask(session, releaseTaskSchema.parse(payload), key);
    default:
      throw new AppError("INVALID_REQUEST", `Unknown MCP tool: ${name}`);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }

  const parsed = jsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) return rpcError(null, -32600, "Invalid Request", 400);
  const rpc = parsed.data;

  try {
    const auth = await authenticateAIRequest(request);
    switch (rpc.method) {
      case "initialize": {
        const initializeParams = z
          .object({ protocolVersion: z.string().optional() })
          .passthrough()
          .parse(rpc.params ?? {});
        return rpcResponse(rpc.id, {
          protocolVersion:
            initializeParams.protocolVersion &&
            SUPPORTED_PROTOCOL_VERSIONS.includes(initializeParams.protocolVersion)
              ? initializeParams.protocolVersion
              : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ai-task-board", version: "0.1.0" },
          instructions: MCP_SERVER_INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
        return new NextResponse(null, { status: 202, headers: noStoreHeaders });
      case "ping":
        return rpcResponse(rpc.id, {});
      case "tools/list":
        return rpcResponse(rpc.id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: advertisedInputSchema(tool),
            annotations: {
              readOnlyHint: Boolean(tool.readOnly),
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          })),
        });
      case "tools/call": {
        const call = toolCallSchema.parse(rpc.params);
        if (!tools.some((tool) => tool.name === call.name)) {
          return rpcError(rpc.id, -32602, "Unknown tool", 400, { name: call.name });
        }
        return rpcResponse(
          rpc.id,
          toolResult(await executeTool(request, auth, call.name, call.arguments)),
        );
      }
      default:
        return rpcError(rpc.id, -32601, "Method not found", 404);
    }
  } catch (error) {
    const normalized = normalizeError(error);
    return rpcError(rpc.id, -32000, normalized.message, normalized.status, {
      code: normalized.code,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    });
  }
}

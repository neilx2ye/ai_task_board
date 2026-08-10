import type { ZodType } from "zod";

import {
  authenticateAIRequest,
  authorizeAISession,
  sessionIdFromRequest,
} from "@/lib/auth/ai-auth";
import { apiSuccess, parseJson, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import type { AIAuthContext, AISessionContext } from "@/lib/types/domain";

export const AI_DEFAULT_BODY_LIMIT_BYTES = 512 * 1024;
export const AI_ACTIVITY_BODY_LIMIT_BYTES = 768 * 1024;
export const AI_INVENTORY_BODY_LIMIT_BYTES = 1152 * 1024;

type AICommandOptions = {
  maxBodyBytes?: number;
};

export function handleAICommand<T>(
  request: Request,
  schema: ZodType<T>,
  command: (
    context: AISessionContext,
    input: T,
    idempotencyKey: string,
  ) => Promise<unknown>,
  options: AICommandOptions = {},
) {
  return withApiHandler(async () => {
    const auth = await authenticateAIRequest(request);
    const context = await authorizeAISession(auth, sessionIdFromRequest(request));
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await parseJson(
      request,
      schema,
      options.maxBodyBytes ?? AI_DEFAULT_BODY_LIMIT_BYTES,
    );
    const result = await command(context, input, idempotencyKey);
    return apiSuccess(result);
  });
}

export function handleAIConnectionCommand<T>(
  request: Request,
  schema: ZodType<T>,
  command: (
    context: AIAuthContext,
    input: T,
    idempotencyKey: string,
  ) => Promise<unknown>,
  options: AICommandOptions = {},
) {
  return withApiHandler(async () => {
    const auth = await authenticateAIRequest(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const input = await parseJson(
      request,
      schema,
      options.maxBodyBytes ?? AI_DEFAULT_BODY_LIMIT_BYTES,
    );
    const result = await command(auth, input, idempotencyKey);
    return apiSuccess(result);
  });
}

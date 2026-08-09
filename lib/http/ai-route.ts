import type { ZodType } from "zod";

import {
  authenticateAIRequest,
  authorizeAISession,
  sessionIdFromRequest,
} from "@/lib/auth/ai-auth";
import { apiSuccess, parseJson, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import type { AIAuthContext, AISessionContext } from "@/lib/types/domain";

export function handleAICommand<T>(
  request: Request,
  schema: ZodType<T>,
  command: (
    context: AISessionContext,
    input: T,
    idempotencyKey: string,
  ) => Promise<unknown>,
) {
  return withApiHandler(async () => {
    const input = await parseJson(request, schema);
    const auth = await authenticateAIRequest(request);
    const context = await authorizeAISession(auth, sessionIdFromRequest(request));
    const result = await command(context, input, requireIdempotencyKey(request));
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
) {
  return withApiHandler(async () => {
    const input = await parseJson(request, schema);
    const auth = await authenticateAIRequest(request);
    const result = await command(auth, input, requireIdempotencyKey(request));
    return apiSuccess(result);
  });
}

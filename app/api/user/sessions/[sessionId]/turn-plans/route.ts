import { createTurnPlanStep, listTurnPlanSteps } from "@/lib/domain/planning";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import {
  createTurnPlanStepSchema,
  sessionParamsSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const context = await userContextForRequest(request);
    return apiSuccess(await listTurnPlanSteps(context, sessionId));
  });
}

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const input = await parseJson(request, createTurnPlanStepSchema);
    const context = await userContextForRequest(request);
    return apiSuccess(
      await createTurnPlanStep(
        context,
        sessionId,
        input,
        requireIdempotencyKey(request),
      ),
      201,
    );
  });
}

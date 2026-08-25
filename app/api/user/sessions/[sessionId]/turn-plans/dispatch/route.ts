import { dispatchTurnPlanChain } from "@/lib/domain/planning";
import {
  apiSuccess,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { sessionParamsSchema } from "@/lib/validation/user";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const context = await userContextForRequest(request);
    return apiSuccess(
      await dispatchTurnPlanChain(
        context,
        sessionId,
        requireIdempotencyKey(request),
      ),
    );
  });
}

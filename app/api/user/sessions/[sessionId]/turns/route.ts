import { createSessionTurn } from "@/lib/domain/users";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import {
  createSessionTurnSchema,
  sessionParamsSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const input = await parseJson(request, createSessionTurnSchema);
    return apiSuccess(
      await createSessionTurn(
        await userContextForRequest(request),
        sessionId,
        input,
        requireIdempotencyKey(request),
      ),
      201,
    );
  });
}

import { updateSessionProcessDetailsSync } from "@/lib/domain/users";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import {
  sessionParamsSchema,
  sessionProcessDetailsSyncSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function PATCH(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const input = await parseJson(request, sessionProcessDetailsSyncSchema);
    return apiSuccess({
      session: await updateSessionProcessDetailsSync(
        await userContextForRequest(request),
        sessionId,
        input,
      ),
    });
  });
}

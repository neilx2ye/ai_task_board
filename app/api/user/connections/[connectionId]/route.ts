import { renameConnection } from "@/lib/domain/users";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import {
  connectionParamsSchema,
  renameConnectionSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function PATCH(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { connectionId } = connectionParamsSchema.parse(await route.params);
    const input = await parseJson(request, renameConnectionSchema);
    return apiSuccess(
      await renameConnection(
        await ownerContextForRequest(request),
        connectionId,
        input,
        requireIdempotencyKey(request),
      ),
    );
  });
}

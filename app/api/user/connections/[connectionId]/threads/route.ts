import { createThread } from "@/lib/domain/users";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import {
  connectionParamsSchema,
  createThreadSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { connectionId } = connectionParamsSchema.parse(await route.params);
    const input = await parseJson(request, createThreadSchema);
    return apiSuccess(
      await createThread(
        await ownerContextForRequest(request),
        connectionId,
        input,
        requireIdempotencyKey(request),
      ),
      202,
    );
  });
}

import {
  deleteThread,
  getSessionConversation,
  renameThread,
} from "@/lib/domain/users";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import {
  ownerContextForRequest,
  userContextForRequest,
} from "@/lib/http/user-route";
import {
  renameThreadSchema,
  sessionConversationQuerySchema,
  sessionParamsSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const query = sessionConversationQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return apiSuccess(
      await getSessionConversation(
        await userContextForRequest(request),
        sessionId,
        {
          beforeActivityCursor: query.before_activity_cursor,
          beforeActivityId: query.before_activity_id,
          limit: query.limit,
        },
      ),
    );
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const input = await parseJson(request, renameThreadSchema);
    return apiSuccess(
      await renameThread(
        await ownerContextForRequest(request),
        sessionId,
        input,
        requireIdempotencyKey(request),
      ),
      202,
    );
  });
}

export async function DELETE(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    return apiSuccess(
      await deleteThread(
        await ownerContextForRequest(request),
        sessionId,
        requireIdempotencyKey(request),
      ),
      202,
    );
  });
}

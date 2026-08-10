import { getSessionConversation } from "@/lib/domain/users";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import {
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

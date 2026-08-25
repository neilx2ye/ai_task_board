import { markSessionCompletionsViewed } from "@/lib/domain/users";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { sessionParamsSchema } from "@/lib/validation/user";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    return apiSuccess(
      await markSessionCompletionsViewed(
        await userContextForRequest(request),
        sessionId,
      ),
    );
  });
}

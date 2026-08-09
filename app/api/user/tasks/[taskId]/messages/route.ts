import { postUserTaskMessage } from "@/lib/domain/users";
import { apiSuccess, parseJson, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { getTaskParamsSchema } from "@/lib/validation/ai";
import { replyToTaskSchema } from "@/lib/validation/user";

type RouteContext = { params: Promise<{ taskId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { taskId } = getTaskParamsSchema.parse(await route.params);
    const input = await parseJson(request, replyToTaskSchema);
    return apiSuccess(
      await postUserTaskMessage(
        await userContextForRequest(request),
        taskId,
        input,
        requireIdempotencyKey(request),
      ),
    );
  });
}

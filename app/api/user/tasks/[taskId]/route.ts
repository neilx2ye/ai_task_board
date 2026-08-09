import { getUserTask, updateUserTask } from "@/lib/domain/users";
import { apiSuccess, parseJson, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { getTaskParamsSchema } from "@/lib/validation/ai";
import { updateTaskSchema } from "@/lib/validation/user";

type RouteContext = { params: Promise<{ taskId: string }> };

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { taskId } = getTaskParamsSchema.parse(await route.params);
    return apiSuccess(await getUserTask(await userContextForRequest(request), taskId));
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { taskId } = getTaskParamsSchema.parse(await route.params);
    const input = await parseJson(request, updateTaskSchema);
    return apiSuccess(
      await updateUserTask(
        await userContextForRequest(request),
        taskId,
        input,
        requireIdempotencyKey(request),
      ),
    );
  });
}

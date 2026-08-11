import { answerTaskUserInputRequest } from "@/lib/domain/users";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import {
  answerTaskUserInputRequestSchema,
  taskUserInputRequestParamsSchema,
} from "@/lib/validation/user";

type RouteContext = {
  params: Promise<{ taskId: string; requestId: string }>;
};

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { taskId, requestId } = taskUserInputRequestParamsSchema.parse(
      await route.params,
    );
    const input = await parseJson(request, answerTaskUserInputRequestSchema);
    return apiSuccess(
      await answerTaskUserInputRequest(
        await userContextForRequest(request),
        taskId,
        requestId,
        input,
        requireIdempotencyKey(request),
      ),
    );
  });
}

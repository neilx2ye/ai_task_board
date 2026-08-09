import { authenticateAIRequest, authorizeAISession, sessionIdFromRequest } from "@/lib/auth/ai-auth";
import { getTask } from "@/lib/domain/tasks";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { getTaskParamsSchema } from "@/lib/validation/ai";

type RouteContext = { params: Promise<{ taskId: string }> };

export async function GET(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { taskId } = getTaskParamsSchema.parse(await context.params);
    const auth = await authenticateAIRequest(request);
    const session = await authorizeAISession(auth, sessionIdFromRequest(request));
    return apiSuccess(await getTask(session, taskId));
  });
}

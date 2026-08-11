import {
  authenticateAIRequest,
  authorizeAISession,
  sessionIdFromRequest,
} from "@/lib/auth/ai-auth";
import { pollTaskUserInputRequest } from "@/lib/domain/tasks";
import { AppError } from "@/lib/domain/errors";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { pollTaskUserInputRequestSchema } from "@/lib/validation/ai";
import { uuidSchema } from "@/lib/validation/common";

type RouteContext = { params: Promise<{ requestId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const requestId = uuidSchema.parse((await route.params).requestId);
    const input = await parseJson(request, pollTaskUserInputRequestSchema);
    if (input.request_id !== requestId) {
      throw new AppError("INVALID_REQUEST", "Request id does not match route");
    }
    const auth = await authenticateAIRequest(request);
    const context = await authorizeAISession(
      auth,
      sessionIdFromRequest(request),
    );
    return apiSuccess(await pollTaskUserInputRequest(context, input));
  });
}

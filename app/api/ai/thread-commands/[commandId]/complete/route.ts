import { authenticateAIRequest } from "@/lib/auth/ai-auth";
import { completeThreadCommand } from "@/lib/domain/thread-management";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { completeThreadCommandSchema } from "@/lib/validation/ai";
import { uuidSchema } from "@/lib/validation/common";

type RouteContext = { params: Promise<{ commandId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const commandId = uuidSchema.parse((await route.params).commandId);
    const auth = await authenticateAIRequest(request);
    const input = await parseJson(request, completeThreadCommandSchema);
    return apiSuccess(await completeThreadCommand(auth, commandId, input));
  });
}

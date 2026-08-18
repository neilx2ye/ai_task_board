import { authenticateAIRequest } from "@/lib/auth/ai-auth";
import { completeFileDeviceCommand } from "@/lib/domain/file-device";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { completeFileCommandSchema } from "@/lib/validation/ai";
import { uuidSchema } from "@/lib/validation/common";

type RouteContext = { params: Promise<{ commandId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const commandId = uuidSchema.parse((await route.params).commandId);
    const auth = await authenticateAIRequest(request);
    const input = await parseJson(request, completeFileCommandSchema);
    return apiSuccess(
      await completeFileDeviceCommand(auth, commandId, input),
    );
  });
}

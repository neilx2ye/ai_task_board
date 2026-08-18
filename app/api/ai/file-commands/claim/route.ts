import { authenticateAIRequest } from "@/lib/auth/ai-auth";
import { claimFileDeviceCommand } from "@/lib/domain/file-device";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { claimFileCommandSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const auth = await authenticateAIRequest(request);
    const input = await parseJson(request, claimFileCommandSchema);
    return apiSuccess(await claimFileDeviceCommand(auth, input));
  });
}

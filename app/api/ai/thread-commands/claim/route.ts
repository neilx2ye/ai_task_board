import { authenticateAIRequest } from "@/lib/auth/ai-auth";
import { claimThreadCommand } from "@/lib/domain/thread-management";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { claimThreadCommandSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const auth = await authenticateAIRequest(request);
    const input = await parseJson(request, claimThreadCommandSchema);
    return apiSuccess(await claimThreadCommand(auth, input));
  });
}

import { authenticateAIRequest } from "@/lib/auth/ai-auth";
import { listCreatedThreadIds } from "@/lib/domain/thread-management";
import { apiSuccess, withApiHandler } from "@/lib/http/api";

export async function GET(request: Request) {
  return withApiHandler(async () =>
    apiSuccess(await listCreatedThreadIds(await authenticateAIRequest(request))),
  );
}

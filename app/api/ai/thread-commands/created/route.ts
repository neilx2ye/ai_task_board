import { authenticateAIRequest } from "@/lib/auth/ai-auth";
import { listCreatedThreadIds } from "@/lib/domain/thread-management";
import { apiSuccess, withApiHandler } from "@/lib/http/api";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const platform =
      new URL(request.url).searchParams.get("platform") ?? null;
    return apiSuccess(
      await listCreatedThreadIds(
        await authenticateAIRequest(request),
        platform,
      ),
    );
  });
}

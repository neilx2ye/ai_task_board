import { listProjectSuggestions } from "@/lib/domain/file-explorer";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    await ownerContextForRequest(request);
    return apiSuccess(await listProjectSuggestions());
  });
}

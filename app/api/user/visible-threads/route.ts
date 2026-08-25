import {
  getVisibleThreads,
  upsertVisibleThreads,
} from "@/lib/domain/thread-view-state";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { upsertVisibleThreadsSchema } from "@/lib/validation/user";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const context = await userContextForRequest(request);
    return apiSuccess(await getVisibleThreads(context));
  });
}

export async function PUT(request: Request) {
  return withApiHandler(async () => {
    const input = await parseJson(request, upsertVisibleThreadsSchema);
    const context = await userContextForRequest(request);
    return apiSuccess(await upsertVisibleThreads(context, input));
  });
}

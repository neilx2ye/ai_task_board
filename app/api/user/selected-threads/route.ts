import {
  getSelectedThreads,
  upsertSelectedThreads,
} from "@/lib/domain/thread-view-state";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { upsertSelectedThreadsSchema } from "@/lib/validation/user";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const context = await userContextForRequest(request);
    return apiSuccess(await getSelectedThreads(context));
  });
}

export async function PUT(request: Request) {
  return withApiHandler(async () => {
    const input = await parseJson(request, upsertSelectedThreadsSchema);
    const context = await userContextForRequest(request);
    return apiSuccess(await upsertSelectedThreads(context, input));
  });
}

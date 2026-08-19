import {
  getThreadPlanningNote,
  upsertThreadPlanningNote,
} from "@/lib/domain/planning";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import {
  sessionParamsSchema,
  upsertThreadPlanningNotesSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const context = await userContextForRequest(request);
    return apiSuccess(await getThreadPlanningNote(context, sessionId));
  });
}

export async function PUT(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    const input = await parseJson(request, upsertThreadPlanningNotesSchema);
    const context = await userContextForRequest(request);
    return apiSuccess(
      await upsertThreadPlanningNote(context, sessionId, input),
    );
  });
}

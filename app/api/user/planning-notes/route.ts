import { getPlanningNote, upsertPlanningNote } from "@/lib/domain/planning";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import {
  planningNotesQuerySchema,
  upsertPlanningNotesSchema,
} from "@/lib/validation/user";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const query = planningNotesQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const context = await userContextForRequest(request);
    return apiSuccess(await getPlanningNote(context, query.project_ref));
  });
}

export async function PUT(request: Request) {
  return withApiHandler(async () => {
    const input = await parseJson(request, upsertPlanningNotesSchema);
    const context = await userContextForRequest(request);
    return apiSuccess(await upsertPlanningNote(context, input));
  });
}

import { deleteTurnPlanStep, updateTurnPlanStep } from "@/lib/domain/planning";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import {
  turnPlanStepParamsSchema,
  updateTurnPlanStepSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ stepId: string }> };

export async function PATCH(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { stepId } = turnPlanStepParamsSchema.parse(await route.params);
    const input = await parseJson(request, updateTurnPlanStepSchema);
    const context = await userContextForRequest(request);
    return apiSuccess(await updateTurnPlanStep(context, stepId, input));
  });
}

export async function DELETE(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { stepId } = turnPlanStepParamsSchema.parse(await route.params);
    const context = await userContextForRequest(request);
    return apiSuccess(await deleteTurnPlanStep(context, stepId));
  });
}

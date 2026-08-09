import type { UserWorkspaceContext } from "@/lib/auth/user";
import { apiSuccess, parseJsonOrEmpty, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { getTaskParamsSchema } from "@/lib/validation/ai";
import { userTaskCommandSchema } from "@/lib/validation/user";

type RouteContext = { params: Promise<{ taskId: string }> };
type TaskCommand = (
  context: UserWorkspaceContext,
  taskId: string,
  reason: string | null,
  idempotencyKey: string,
) => Promise<unknown>;

export function handleUserTaskCommand(
  request: Request,
  route: RouteContext,
  command: TaskCommand,
) {
  return withApiHandler(async () => {
    const { taskId } = getTaskParamsSchema.parse(await route.params);
    const input = await parseJsonOrEmpty(request, userTaskCommandSchema);
    const result = await command(
      await userContextForRequest(request),
      taskId,
      input.reason ?? null,
      requireIdempotencyKey(request),
    );
    return apiSuccess(result);
  });
}

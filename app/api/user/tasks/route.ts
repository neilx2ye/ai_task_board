import { createUserTask, listUserTasks } from "@/lib/domain/users";
import { requireUserWorkspace } from "@/lib/auth/user";
import { apiSuccess, parseJson, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { createTaskSchema, taskListQuerySchema } from "@/lib/validation/user";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const query = taskListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const context = await userContextForRequest(request);
    return apiSuccess(await listUserTasks(context, query));
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const input = await parseJson(request, createTaskSchema);
    const context = await requireUserWorkspace(input.workspace_id);
    return apiSuccess(await createUserTask(context, input, requireIdempotencyKey(request)), 201);
  });
}

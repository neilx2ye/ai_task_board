import { requireWorkspaceOwner } from "@/lib/auth/user";
import { createConnection, listConnections } from "@/lib/domain/users";
import { apiSuccess, parseJson, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import { createConnectionSchema } from "@/lib/validation/user";

export async function GET(request: Request) {
  return withApiHandler(async () =>
    apiSuccess(await listConnections(await ownerContextForRequest(request))),
  );
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const input = await parseJson(request, createConnectionSchema);
    const context = await requireWorkspaceOwner(input.workspace_id);
    return apiSuccess(
      await createConnection(context, input, requireIdempotencyKey(request)),
      201,
    );
  });
}

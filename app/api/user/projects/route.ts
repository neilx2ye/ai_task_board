import {
  createProjectOnBridges,
  deleteProjectOnBridges,
  updateProjectOnBridges,
} from "@/lib/domain/projects";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import {
  createProjectSchema,
  deleteProjectSchema,
  updateProjectSchema,
} from "@/lib/validation/projects";

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const input = await parseJson(request, createProjectSchema);
    return apiSuccess(
      await createProjectOnBridges(
        await ownerContextForRequest(request),
        input,
        requireIdempotencyKey(request),
      ),
    );
  });
}

export async function PATCH(request: Request) {
  return withApiHandler(async () => {
    const input = await parseJson(request, updateProjectSchema);
    return apiSuccess(
      await updateProjectOnBridges(
        await ownerContextForRequest(request),
        input,
        requireIdempotencyKey(request),
      ),
    );
  });
}

export async function DELETE(request: Request) {
  return withApiHandler(async () => {
    const input = await parseJson(request, deleteProjectSchema);
    return apiSuccess(
      await deleteProjectOnBridges(
        await ownerContextForRequest(request),
        input,
        requireIdempotencyKey(request),
      ),
    );
  });
}

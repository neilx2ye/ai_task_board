import { createProjectOnBridges } from "@/lib/domain/projects";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import { createProjectSchema } from "@/lib/validation/projects";

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

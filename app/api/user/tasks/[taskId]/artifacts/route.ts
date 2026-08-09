import { uploadUserArtifact } from "@/lib/domain/users";
import { AppError } from "@/lib/domain/errors";
import { apiSuccess, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { getTaskParamsSchema } from "@/lib/validation/ai";
import { uploadFileSchema } from "@/lib/validation/artifacts";

type RouteContext = { params: Promise<{ taskId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { taskId } = getTaskParamsSchema.parse(await route.params);
    const context = await userContextForRequest(request);
    const idempotencyKey = requireIdempotencyKey(request);
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new AppError("INVALID_REQUEST", "Request must be multipart form data");
    }
    const file = uploadFileSchema.parse(formData.get("file"));
    const artifact = await uploadUserArtifact(context, taskId, file, idempotencyKey);
    return apiSuccess(artifact, 201);
  });
}

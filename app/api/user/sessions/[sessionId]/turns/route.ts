import { createSessionTurn } from "@/lib/domain/users";
import { AppError } from "@/lib/domain/errors";
import { apiSuccess, parseJson, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";
import { validateTurnImages } from "@/lib/validation/artifacts";
import {
  createSessionTurnSchema,
  sessionParamsSchema,
} from "@/lib/validation/user";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { sessionId } = sessionParamsSchema.parse(await route.params);
    let input;
    let images: File[] = [];
    if (request.headers.get("content-type")?.includes("application/json")) {
      input = await parseJson(request, createSessionTurnSchema);
    } else {
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        throw new AppError("INVALID_REQUEST", "Request must be multipart form data");
      }
      input = createSessionTurnSchema.parse({ content: formData.get("content") });
      try {
        images = validateTurnImages(
          formData.getAll("images").filter((value): value is File => value instanceof File),
        );
      } catch (error) {
        throw new AppError(
          "INVALID_REQUEST",
          error instanceof Error ? error.message : "Invalid turn images",
        );
      }
    }
    return apiSuccess(
      await createSessionTurn(
        await userContextForRequest(request),
        sessionId,
        images.length ? { ...input, images } : input,
        requireIdempotencyKey(request),
      ),
      201,
    );
  });
}

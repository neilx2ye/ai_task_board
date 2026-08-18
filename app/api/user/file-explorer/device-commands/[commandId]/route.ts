import { getFileDeviceCommand } from "@/lib/domain/file-device";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import { deviceFileCommandParamsSchema } from "@/lib/validation/user";

type RouteContext = { params: Promise<{ commandId: string }> };

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const context = await ownerContextForRequest(request);
    const { commandId } = deviceFileCommandParamsSchema.parse(
      await route.params,
    );
    return apiSuccess(await getFileDeviceCommand(context, commandId));
  });
}

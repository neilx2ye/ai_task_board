import { enqueueFileDeviceCommand } from "@/lib/domain/file-device";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import { createDeviceFileCommandSchema } from "@/lib/validation/user";

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const context = await ownerContextForRequest(request);
    const input = await parseJson(request, createDeviceFileCommandSchema);
    return apiSuccess(await enqueueFileDeviceCommand(context, input));
  });
}

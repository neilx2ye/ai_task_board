import { getLatestBridgeRelease } from "@/lib/bridge-release";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    await userContextForRequest(request);
    return apiSuccess({
      latest_version: await getLatestBridgeRelease(),
    });
  });
}

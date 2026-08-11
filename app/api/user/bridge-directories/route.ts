import { listBridgeDirectories } from "@/lib/domain/bridge-directories";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";

export async function GET(request: Request) {
  return withApiHandler(async () =>
    apiSuccess(
      await listBridgeDirectories(await userContextForRequest(request)),
    ),
  );
}

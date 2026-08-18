import { listProjectSuggestions } from "@/lib/domain/file-explorer";
import { listFileExplorerBridgeProjects } from "@/lib/domain/file-device";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const context = await ownerContextForRequest(request);
    const [local, bridgeProjects] = await Promise.all([
      listProjectSuggestions(),
      listFileExplorerBridgeProjects(context),
    ]);
    return apiSuccess({ ...local, bridgeProjects });
  });
}

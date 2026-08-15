import { listDirectoryContents } from "@/lib/domain/file-explorer";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    await ownerContextForRequest(request);
    const target = new URL(request.url).searchParams.get("path") ?? "";
    return apiSuccess(await listDirectoryContents(target));
  });
}

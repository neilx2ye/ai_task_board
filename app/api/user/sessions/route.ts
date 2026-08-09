import { listSessions } from "@/lib/domain/users";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";

export async function GET(request: Request) {
  return withApiHandler(async () => apiSuccess(await listSessions(await userContextForRequest(request))));
}

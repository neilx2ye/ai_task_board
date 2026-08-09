import { z } from "zod";

import { rotateConnection } from "@/lib/domain/users";
import { apiSuccess, requireIdempotencyKey, withApiHandler } from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const idempotencyKey = requireIdempotencyKey(request);
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(await route.params);
    return apiSuccess(
      await rotateConnection(await ownerContextForRequest(request), connectionId, idempotencyKey),
    );
  });
}

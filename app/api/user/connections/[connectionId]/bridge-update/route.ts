import { z } from "zod";

import { setBridgeUpdateTarget } from "@/lib/domain/bridge-update";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import { updateBridgeVersionSchema } from "@/lib/validation/bridge-config";

type RouteContext = { params: Promise<{ connectionId: string }> };

const connectionParamsSchema = z
  .object({ connectionId: z.string().uuid() })
  .strict();

export async function POST(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { connectionId } = connectionParamsSchema.parse(await route.params);
    const input = await parseJson(request, updateBridgeVersionSchema);
    requireIdempotencyKey(request);
    return apiSuccess(
      await setBridgeUpdateTarget(
        await ownerContextForRequest(request),
        connectionId,
        input,
      ),
    );
  });
}

import { z } from "zod";

import {
  getBridgeConfiguration,
  updateBridgeConfiguration,
} from "@/lib/domain/bridge-config";
import {
  apiSuccess,
  parseJson,
  requireIdempotencyKey,
  withApiHandler,
} from "@/lib/http/api";
import { ownerContextForRequest } from "@/lib/http/user-route";
import {
  BRIDGE_CONFIG_BODY_LIMIT_BYTES,
  updateBridgeConfigurationSchema,
} from "@/lib/validation/bridge-config";

type RouteContext = { params: Promise<{ connectionId: string }> };

const connectionParamsSchema = z
  .object({ connectionId: z.string().uuid() })
  .strict();

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { connectionId } = connectionParamsSchema.parse(await route.params);
    const platform =
      new URL(request.url).searchParams.get("platform") ?? undefined;
    return apiSuccess(
      await getBridgeConfiguration(
        await ownerContextForRequest(request),
        connectionId,
        platform,
      ),
    );
  });
}

export async function PATCH(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { connectionId } = connectionParamsSchema.parse(await route.params);
    const platform =
      new URL(request.url).searchParams.get("platform") ?? undefined;
    const input = await parseJson(
      request,
      updateBridgeConfigurationSchema,
      BRIDGE_CONFIG_BODY_LIMIT_BYTES,
    );
    return apiSuccess(
      await updateBridgeConfiguration(
        await ownerContextForRequest(request),
        connectionId,
        platform,
        input,
        requireIdempotencyKey(request),
      ),
    );
  });
}

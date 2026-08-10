import { authenticateAIRequest } from "@/lib/auth/ai-auth";
import { exchangeBridgeConfiguration } from "@/lib/domain/bridge-config";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import {
  BRIDGE_CONFIG_BODY_LIMIT_BYTES,
  exchangeBridgeConfigurationSchema,
} from "@/lib/validation/bridge-config";

/** Report the local safety envelope/effective state and fetch desired config. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const auth = await authenticateAIRequest(request);
    const input = await parseJson(
      request,
      exchangeBridgeConfigurationSchema,
      BRIDGE_CONFIG_BODY_LIMIT_BYTES,
    );
    return apiSuccess(await exchangeBridgeConfiguration(auth, input));
  });
}

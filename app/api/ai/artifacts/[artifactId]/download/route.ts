import { z } from "zod";

import { authenticateAIRequest, authorizeAISession, sessionIdFromRequest } from "@/lib/auth/ai-auth";
import { createAIArtifactDownload } from "@/lib/domain/tasks";
import { apiSuccess, withApiHandler } from "@/lib/http/api";

type RouteContext = { params: Promise<{ artifactId: string }> };

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { artifactId } = z.object({ artifactId: z.string().uuid() }).parse(await route.params);
    const auth = await authenticateAIRequest(request);
    const session = await authorizeAISession(auth, sessionIdFromRequest(request));
    return apiSuccess(await createAIArtifactDownload(session, artifactId));
  });
}

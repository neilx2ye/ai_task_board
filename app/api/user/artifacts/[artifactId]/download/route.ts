import { z } from "zod";

import { createArtifactDownload } from "@/lib/domain/users";
import { apiSuccess, withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";

type RouteContext = { params: Promise<{ artifactId: string }> };

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { artifactId } = z.object({ artifactId: z.string().uuid() }).parse(await route.params);
    return apiSuccess(
      await createArtifactDownload(await userContextForRequest(request), artifactId),
    );
  });
}

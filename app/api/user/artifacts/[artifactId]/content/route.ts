import { z } from "zod";
import { NextResponse } from "next/server";

import { createArtifactDownload } from "@/lib/domain/users";
import { withApiHandler } from "@/lib/http/api";
import { userContextForRequest } from "@/lib/http/user-route";

type RouteContext = { params: Promise<{ artifactId: string }> };

export async function GET(request: Request, route: RouteContext) {
  return withApiHandler(async () => {
    const { artifactId } = z.object({ artifactId: z.string().uuid() }).parse(await route.params);
    const result = await createArtifactDownload(await userContextForRequest(request), artifactId);
    return NextResponse.redirect(result.url, 307);
  });
}

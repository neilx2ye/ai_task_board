import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import { isSignupEnabled } from "@/lib/env";
import { withApiHandler } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return withApiHandler(async () => {
    const user = await getSessionUser();
    return NextResponse.json(
      { user, signupEnabled: isSignupEnabled() },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

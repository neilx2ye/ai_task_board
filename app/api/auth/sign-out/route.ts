import { NextResponse } from "next/server";

import { signOut } from "@/lib/auth/session";
import { withApiHandler } from "@/lib/http/api";

export const runtime = "nodejs";

export async function POST(): Promise<NextResponse> {
  return withApiHandler(async () => {
    await signOut();
    return NextResponse.json({ ok: true });
  });
}

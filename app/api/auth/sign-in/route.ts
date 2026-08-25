import { NextResponse } from "next/server";

import { signInWithPassword } from "@/lib/auth/session";
import { parseJson, withApiHandler } from "@/lib/http/api";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim(),
  password: z.string(),
});

export async function POST(request: Request): Promise<NextResponse> {
  return withApiHandler(async () => {
    const input = await parseJson(request, schema);
    await signInWithPassword(input.email, input.password);
    return NextResponse.json({ ok: true });
  });
}

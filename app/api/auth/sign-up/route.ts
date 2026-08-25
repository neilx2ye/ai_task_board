import { NextResponse } from "next/server";

import { signUpWithPassword } from "@/lib/auth/session";
import { isSignupEnabled } from "@/lib/env";
import { AppError } from "@/lib/domain/errors";
import { parseJson, withApiHandler } from "@/lib/http/api";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim(),
  password: z.string(),
});

export async function POST(request: Request): Promise<NextResponse> {
  return withApiHandler(async () => {
    if (!isSignupEnabled()) {
      throw new AppError("FORBIDDEN", "注册入口已关闭");
    }
    const input = await parseJson(request, schema);
    await signUpWithPassword(input.email, input.password);
    return NextResponse.json({ ok: true });
  });
}

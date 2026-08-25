import { NextResponse } from "next/server";

import { AppError } from "@/lib/domain/errors";
import { readObject, verifySignedObjectUrl } from "@/lib/storage/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves a locally stored object when its HMAC-signed URL is still valid.
 * The signature is derived from AI_TOKEN_PEPPER and expires after the TTL
 * requested at signing time.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = {
    bucket: url.searchParams.get("bucket") ?? "",
    path: url.searchParams.get("path") ?? "",
    expires: url.searchParams.get("expires") ?? "",
    sig: url.searchParams.get("sig") ?? "",
  };
  const check = verifySignedObjectUrl(params);
  if (!check.valid) {
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN",
          message:
            check.reason === "expired"
              ? "The signed URL has expired"
              : "Invalid signed URL",
        },
      },
      { status: 403 },
    );
  }

  try {
    const bytes = readObject(params.bucket, params.path);
    if (!bytes) {
      throw new AppError("PATH_NOT_FOUND", "Object not found");
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Could not read object" } },
      { status: 500 },
    );
  }
}

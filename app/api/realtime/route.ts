import { Client } from "pg";

import { requireUserWorkspace } from "@/lib/auth/user";
import { connectionString } from "@/lib/db";
import { apiError } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_AGE_MS = 10 * 60_000;
const encoder = new TextEncoder();

/**
 * Workspace-scoped SSE stream backed by PostgreSQL LISTEN/NOTIFY. Each event
 * carries only `{ table }`; the browser maps the table to query-key
 * invalidations. Reconnect is handled by the EventSource client, which also
 * performs a full invalidation after every successful (re)connect.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const workspaceId =
      new URL(request.url).searchParams.get("workspace_id") ?? "";
    const context = await requireUserWorkspace(workspaceId);
    const client = new Client({ connectionString: connectionString() });
    await client.connect();
    await client.query("listen atb_realtime");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let keepalive: ReturnType<typeof setInterval> | null = null;
        let maxAge: ReturnType<typeof setTimeout> | null = null;
        let ending = false;

        const endClient = () => {
          if (ending) return;
          ending = true;
          void client.end().catch(() => undefined);
        };
        const close = () => {
          if (closed) return;
          closed = true;
          if (keepalive) clearInterval(keepalive);
          if (maxAge) clearTimeout(maxAge);
          endClient();
          try {
            controller.close();
          } catch {
            // The consumer may already have cancelled the stream.
          }
        };
        const enqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            close();
          }
        };

        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) {
          close();
          return;
        }

        client.on("notification", (message) => {
          if (!message.payload) return;
          try {
            const payload = JSON.parse(message.payload) as {
              table?: string;
              workspace_id?: string;
            };
            if (payload.workspace_id !== context.workspaceId) return;
            enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ table: payload.table })}\n\n`,
              ),
            );
          } catch {
            // A malformed notification must not take down the stream.
          }
        });
        client.on("error", () => close());

        enqueue(encoder.encode("retry: 2000\n\n"));
        keepalive = setInterval(() => {
          enqueue(encoder.encode(": keepalive\n\n"));
        }, KEEPALIVE_INTERVAL_MS);
        maxAge = setTimeout(() => {
          enqueue(encoder.encode("event: reconnect\ndata: {}\n\n"));
          close();
        }, MAX_STREAM_AGE_MS);
      },
      cancel() {
        void client.end().catch(() => undefined);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

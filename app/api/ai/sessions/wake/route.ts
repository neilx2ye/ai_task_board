import { randomUUID } from "node:crypto";

import type { RealtimeChannel } from "@supabase/supabase-js";

import {
  authenticateAIRequest,
  authorizeAISession,
  sessionIdFromRequest,
} from "@/lib/auth/ai-auth";
import { apiError } from "@/lib/http/api";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_AGE_MS = 5 * 60_000;
const encoder = new TextEncoder();

function eventFrame(event: string): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: {}\n\n`);
}

/**
 * Authenticated, data-free wake hints for one AI Session.
 *
 * The service-role Realtime subscription never crosses this boundary: clients
 * only receive fixed SSE frames and must still claim the authoritative task via
 * the normal Connection Token REST endpoint.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await authenticateAIRequest(request);
    const context = await authorizeAISession(
      auth,
      sessionIdFromRequest(request),
    );
    const admin = createAdminClient();
    let cancelStream: () => void = () => undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let finalized = false;
        let channel: RealtimeChannel | null = null;
        const timers: {
          keepalive?: ReturnType<typeof setInterval>;
          maxAge?: ReturnType<typeof setTimeout>;
        } = {};

        const finalize = () => {
          if (finalized) return;
          finalized = true;
          if (timers.keepalive) clearInterval(timers.keepalive);
          if (timers.maxAge) clearTimeout(timers.maxAge);
          request.signal.removeEventListener("abort", close);
          const activeChannel = channel;
          channel = null;
          if (activeChannel) {
            void admin.removeChannel(activeChannel).catch(() => undefined);
          }
        };

        const enqueue = (chunk: Uint8Array) => {
          if (finalized) return;
          try {
            controller.enqueue(chunk);
          } catch {
            finalize();
          }
        };

        function close() {
          if (finalized) return;
          try {
            controller.close();
          } catch {
            // The consumer may already have cancelled the Web Stream.
          } finally {
            finalize();
          }
        }

        cancelStream = finalize;
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) {
          close();
          return;
        }

        // Browsers and proxies use this value if they ever consume the stream;
        // the Bridge also applies its own bounded reconnect backoff.
        enqueue(encoder.encode("retry: 2000\n\n"));

        try {
          const wakeChannel = admin.channel(
            `ai-session-wake:${context.sessionId}:${randomUUID()}`,
          );
          channel = wakeChannel;
          wakeChannel
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "tasks",
                filter: `assigned_session_id=eq.${context.sessionId}`,
              },
              (payload) => {
                const row = payload.new as { status?: unknown };
                if (row.status === "ready") enqueue(eventFrame("wake"));
              },
            )
            .subscribe((status) => {
              if (status === "SUBSCRIBED") {
                // Claim once after the subscription is live to close the race
                // between the Bridge's initial empty claim and channel setup.
                enqueue(eventFrame("ready"));
                return;
              }
              if (
                status === "CHANNEL_ERROR" ||
                status === "TIMED_OUT" ||
                status === "CLOSED"
              ) {
                enqueue(eventFrame("degraded"));
                close();
              }
            });
        } catch {
          // Do not retain a half-created channel on the singleton admin client.
          // A fixed degraded frame keeps setup errors free of server details.
          enqueue(eventFrame("degraded"));
          close();
        }

        // A subscription callback can fail synchronously in mocks or alternate
        // transports; do not create timers after that path has finalized.
        if (finalized) return;

        // A short comment keeps Caddy/CDN idle timers from mistaking a healthy
        // SSE stream for a dead request without exposing task or session data.
        timers.keepalive = setInterval(() => {
          enqueue(encoder.encode(": keepalive\n\n"));
        }, KEEPALIVE_INTERVAL_MS);

        // Reauthenticate periodically so a revoked Connection Token cannot keep
        // an already-open stream indefinitely, and to shed stale channels.
        timers.maxAge = setTimeout(() => {
          enqueue(eventFrame("reconnect"));
          close();
        }, MAX_STREAM_AGE_MS);
      },
      cancel() {
        cancelStream();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Cache-Control": "no-cache, no-store, no-transform",
        "Content-Encoding": "identity",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

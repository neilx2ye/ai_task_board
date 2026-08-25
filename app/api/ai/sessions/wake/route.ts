import {
  authenticateAIRequest,
  authorizeAISession,
  sessionIdFromRequest,
} from "@/lib/auth/ai-auth";
import { query } from "@/lib/db";
import { apiError } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_AGE_MS = 5 * 60_000;
const WAKE_POLL_INTERVAL_MS = 1_000;
const encoder = new TextEncoder();

function eventFrame(event: string): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: {}\n\n`);
}

type OpenWakeStream = {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
};

/**
 * Live wake streams, used by a single process-wide signal listener. `next
 * start` drains in-flight requests on SIGTERM/SIGINT, and a wake stream can
 * live for up to MAX_STREAM_AGE_MS. Without ending the streams first, every
 * graceful stop blocks until systemd force-kills the server, turning each
 * deploy into a 502 window for all devices.
 */
const openWakeStreams = new Set<OpenWakeStream>();
let shutdownListenersInstalled = false;

function installShutdownListeners(): void {
  if (shutdownListenersInstalled) return;
  shutdownListenersInstalled = true;
  const shutdown = () => {
    for (const stream of [...openWakeStreams]) {
      // Reconnect hint first so each Bridge re-establishes the channel as
      // soon as the new process is up.
      try {
        stream.enqueue(eventFrame("reconnect"));
      } catch {
        // The stream may already be closing; ending it is all that matters.
      }
      stream.close();
    }
    openWakeStreams.clear();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
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
    let cancelStream: () => void = () => undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let finalized = false;
        const timers: {
          keepalive?: ReturnType<typeof setInterval>;
          maxAge?: ReturnType<typeof setTimeout>;
          wakePoll?: ReturnType<typeof setInterval>;
        } = {};
        let registration: OpenWakeStream | null = null;

        const finalize = () => {
          if (finalized) return;
          finalized = true;
          if (timers.keepalive) clearInterval(timers.keepalive);
          if (timers.maxAge) clearTimeout(timers.maxAge);
          if (timers.wakePoll) clearInterval(timers.wakePoll);
          request.signal.removeEventListener("abort", close);
          if (registration) openWakeStreams.delete(registration);
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
        registration = { enqueue, close };
        openWakeStreams.add(registration);
        installShutdownListeners();
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) {
          close();
          return;
        }

        // Browsers and proxies use this value if they ever consume the stream;
        // the Bridge also applies its own bounded reconnect backoff.
        enqueue(encoder.encode("retry: 2000\n\n"));

        // Emit one ready hint immediately, mirroring the previous "subscription
        // is live" signal, then poll for work assigned to this session. The
        // Bridge still claims the authoritative task through the REST API.
        enqueue(eventFrame("ready"));
        let woke = false;
        timers.wakePoll = setInterval(() => {
          if (woke || finalized) return;
          void query(
            `select 1
             from public.tasks
             where assigned_session_id = $1::uuid
               and status = 'ready'
             limit 1`,
            [context.sessionId],
          )
            .then((result) => {
              if (result.rows.length > 0 && !finalized) {
                woke = true;
                if (timers.wakePoll) clearInterval(timers.wakePoll);
                enqueue(eventFrame("wake"));
              }
            })
            .catch(() => {
              enqueue(eventFrame("degraded"));
              close();
            });
        }, WAKE_POLL_INTERVAL_MS);

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

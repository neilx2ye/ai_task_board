import {
  authenticateAIRequest,
  authorizeAISession,
  sessionIdFromRequest,
} from "@/lib/auth/ai-auth";
import { importSessionHistory } from "@/lib/domain/session-history";
import { apiSuccess, parseJson, withApiHandler } from "@/lib/http/api";
import { AI_HISTORY_BODY_LIMIT_BYTES } from "@/lib/http/ai-route";
import { importSessionHistorySchema } from "@/lib/validation/ai";

/** Import one runtime-fenced, append-only page of normalized Codex history. */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    // Never consume a potentially large or hostile body until both the
    // connection token and its session ownership have been verified.
    const auth = await authenticateAIRequest(request);
    const context = await authorizeAISession(
      auth,
      sessionIdFromRequest(request),
    );
    const input = await parseJson(
      request,
      importSessionHistorySchema,
      AI_HISTORY_BODY_LIMIT_BYTES,
    );
    return apiSuccess(await importSessionHistory(context, input));
  });
}

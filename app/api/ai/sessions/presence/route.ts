import { heartbeatSession } from "@/lib/domain/sessions";
import { handleAICommand } from "@/lib/http/ai-route";
import { sessionHeartbeatSchema } from "@/lib/validation/ai";

/** Refresh an idle session's presence without requiring an active task claim. */
export async function POST(request: Request) {
  return handleAICommand(request, sessionHeartbeatSchema, heartbeatSession);
}

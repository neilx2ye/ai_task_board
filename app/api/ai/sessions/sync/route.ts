import { syncSessions } from "@/lib/domain/sessions";
import {
  AI_INVENTORY_BODY_LIMIT_BYTES,
  handleAIConnectionCommand,
} from "@/lib/http/ai-route";
import { syncSessionsSchema } from "@/lib/validation/ai";

/** Refresh one Bridge device and its complete local Codex thread inventory. */
export async function POST(request: Request) {
  return handleAIConnectionCommand(request, syncSessionsSchema, syncSessions, {
    maxBodyBytes: AI_INVENTORY_BODY_LIMIT_BYTES,
  });
}

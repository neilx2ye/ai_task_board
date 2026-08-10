import { reportSessionActivity } from "@/lib/domain/tasks";
import {
  AI_ACTIVITY_BODY_LIMIT_BYTES,
  handleAICommand,
} from "@/lib/http/ai-route";
import { reportSessionActivitySchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(
    request,
    reportSessionActivitySchema,
    reportSessionActivity,
    { maxBodyBytes: AI_ACTIVITY_BODY_LIMIT_BYTES },
  );
}

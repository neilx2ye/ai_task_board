import { heartbeatClaim } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { heartbeatClaimSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, heartbeatClaimSchema, heartbeatClaim);
}

import { completeTaskAndClaimNext } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { completeAndClaimNextSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, completeAndClaimNextSchema, completeTaskAndClaimNext);
}

import { claimTask } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { claimTaskSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, claimTaskSchema, claimTask);
}

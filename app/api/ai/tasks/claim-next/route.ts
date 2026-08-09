import { claimNextTask } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { claimOptionsSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, claimOptionsSchema, claimNextTask);
}

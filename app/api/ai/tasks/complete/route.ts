import { completeTask } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { completeTaskSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, completeTaskSchema, completeTask);
}

import { createSubtasks } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { createSubtasksSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, createSubtasksSchema, createSubtasks);
}

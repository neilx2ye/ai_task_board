import { releaseTask } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { releaseTaskSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, releaseTaskSchema, releaseTask);
}

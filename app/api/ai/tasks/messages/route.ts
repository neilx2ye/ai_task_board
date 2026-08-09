import { postTaskMessage } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { postTaskMessageSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, postTaskMessageSchema, postTaskMessage);
}

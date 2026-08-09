import { requestUserInput } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { requestUserInputSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, requestUserInputSchema, requestUserInput);
}

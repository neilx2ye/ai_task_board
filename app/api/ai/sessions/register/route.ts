import { registerSession } from "@/lib/domain/sessions";
import { handleAIConnectionCommand } from "@/lib/http/ai-route";
import { registerSessionSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAIConnectionCommand(request, registerSessionSchema, registerSession);
}

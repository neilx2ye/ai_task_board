import { reportProgress } from "@/lib/domain/tasks";
import { handleAICommand } from "@/lib/http/ai-route";
import { reportProgressSchema } from "@/lib/validation/ai";

export async function POST(request: Request) {
  return handleAICommand(request, reportProgressSchema, reportProgress);
}

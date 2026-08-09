import { cancelUserTask } from "@/lib/domain/users";
import { handleUserTaskCommand } from "@/lib/http/user-task-command";

type RouteContext = { params: Promise<{ taskId: string }> };

export async function POST(request: Request, route: RouteContext) {
  return handleUserTaskCommand(request, route, cancelUserTask);
}

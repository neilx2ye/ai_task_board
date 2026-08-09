import { requireUserWorkspace, requireWorkspaceOwner } from "@/lib/auth/user";
import { uuidSchema } from "@/lib/validation/common";

export function workspaceIdFromUrl(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get("workspace_id");
  return value ? uuidSchema.parse(value) : undefined;
}

export async function userContextForRequest(request: Request) {
  return requireUserWorkspace(workspaceIdFromUrl(request));
}

export async function ownerContextForRequest(request: Request) {
  return requireWorkspaceOwner(workspaceIdFromUrl(request));
}

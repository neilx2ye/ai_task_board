import "server-only";

import { getSessionUser } from "@/lib/auth/session";
import { query } from "@/lib/db";
import { AppError } from "@/lib/domain/errors";
import type { MemberRole } from "@/lib/types/database";

export type UserWorkspaceContext = {
  userId: string;
  workspaceId: string;
  role: MemberRole;
};

export async function requireUserWorkspace(
  requestedWorkspaceId?: string | null,
): Promise<UserWorkspaceContext> {
  const user = await getSessionUser();
  if (!user) {
    throw new AppError("AUTHENTICATION_REQUIRED", "Sign in is required");
  }

  const params: unknown[] = [user.id];
  let sql = `select workspace_id, role
             from public.workspace_members
             where user_id = $1::uuid`;
  if (requestedWorkspaceId) {
    params.push(requestedWorkspaceId);
    sql += ` and workspace_id = $2::uuid`;
  }
  sql += ` order by created_at limit 1`;
  const { rows } = await query<{
    workspace_id: string;
    role: MemberRole;
  }>(sql, params);
  const membership = rows[0];
  if (!membership) {
    throw new AppError("FORBIDDEN", "No accessible workspace was found");
  }

  return {
    userId: user.id,
    workspaceId: membership.workspace_id,
    role: membership.role,
  };
}

export async function requireWorkspaceOwner(
  requestedWorkspaceId?: string | null,
): Promise<UserWorkspaceContext> {
  const context = await requireUserWorkspace(requestedWorkspaceId);
  if (context.role !== "owner") {
    throw new AppError("FORBIDDEN", "Workspace owner access is required");
  }
  return context;
}

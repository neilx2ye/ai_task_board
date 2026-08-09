import "server-only";

import { AppError, mapDatabaseError } from "@/lib/domain/errors";
import { createClient } from "@/lib/supabase/server";
import type { MemberRole } from "@/lib/types/database";

export type UserWorkspaceContext = {
  userId: string;
  workspaceId: string;
  role: MemberRole;
};

export async function requireUserWorkspace(
  requestedWorkspaceId?: string | null,
): Promise<UserWorkspaceContext> {
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    throw new AppError("AUTHENTICATION_REQUIRED", "Sign in is required");
  }

  let query = supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", authData.user.id);
  if (requestedWorkspaceId) query = query.eq("workspace_id", requestedWorkspaceId);
  const { data: membership, error } = await query.order("created_at").limit(1).maybeSingle();
  if (error) throw mapDatabaseError(error);
  if (!membership) throw new AppError("FORBIDDEN", "No accessible workspace was found");

  return {
    userId: authData.user.id,
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

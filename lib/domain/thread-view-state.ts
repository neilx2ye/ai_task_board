import "server-only";

import type { UserWorkspaceContext } from "@/lib/auth/user";
import { mapDatabaseError } from "@/lib/domain/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  UpsertSelectedThreadsInput,
  UpsertVisibleThreadsInput,
} from "@/lib/validation/user";

export type SelectedThreadsState = {
  selected_session_ids: string[];
};

export type VisibleThreadsState = {
  visible_session_ids: string[];
};

export async function getSelectedThreads(
  context: UserWorkspaceContext,
): Promise<{ threads: SelectedThreadsState | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_thread_view_state")
    .select("selected_session_ids")
    .eq("workspace_id", context.workspaceId)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  return { threads: data };
}

export async function upsertSelectedThreads(
  context: UserWorkspaceContext,
  input: UpsertSelectedThreadsInput,
): Promise<{ threads: SelectedThreadsState }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_thread_view_state")
    .upsert(
      {
        workspace_id: context.workspaceId,
        user_id: context.userId,
        selected_session_ids: input.session_ids,
      },
      { onConflict: "workspace_id,user_id" },
    )
    .select("selected_session_ids")
    .single();
  if (error) throw mapDatabaseError(error);
  return { threads: data };
}

export async function getVisibleThreads(
  context: UserWorkspaceContext,
): Promise<{ threads: VisibleThreadsState | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_thread_view_state")
    .select("visible_session_ids")
    .eq("workspace_id", context.workspaceId)
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error) throw mapDatabaseError(error);
  return { threads: data };
}

export async function upsertVisibleThreads(
  context: UserWorkspaceContext,
  input: UpsertVisibleThreadsInput,
): Promise<{ threads: VisibleThreadsState }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_thread_view_state")
    .upsert(
      {
        workspace_id: context.workspaceId,
        user_id: context.userId,
        visible_session_ids: input.session_ids,
      },
      { onConflict: "workspace_id,user_id" },
    )
    .select("visible_session_ids")
    .single();
  if (error) throw mapDatabaseError(error);
  return { threads: data };
}

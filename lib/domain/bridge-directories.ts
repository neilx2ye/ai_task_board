import "server-only";

import type { UserWorkspaceContext } from "@/lib/auth/user";
import { mapDatabaseError } from "@/lib/domain/errors";
import { collectRangePages } from "@/lib/domain/postgrest-pagination";
import { createAdminClient } from "@/lib/supabase/admin";

export async function listBridgeDirectories(context: UserWorkspaceContext) {
  const admin = createAdminClient();
  const directories = await collectRangePages(async (from, to) => {
    const { data, error } = await admin
      .from("ai_bridge_directories")
      .select("*")
      .eq("workspace_id", context.workspaceId)
      .order("connection_id")
      .order("inventory_active", { ascending: false })
      .order("name")
      .order("directory_key")
      .range(from, to);
    if (error) throw mapDatabaseError(error);
    return data ?? [];
  });
  return { directories };
}

import "server-only";

import type { UserWorkspaceContext } from "@/lib/auth/user";
import { mapDatabaseError } from "@/lib/domain/errors";
import { collectRangePages } from "@/lib/domain/postgrest-pagination";
import { createAdminClient } from "@/lib/supabase/admin";

type DatabaseErrorLike = {
  code?: string;
  message?: string;
};

function isMissingDirectoryInventorySchema(error: DatabaseErrorLike): boolean {
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = error.message ?? "";
  return (
    message.includes("ai_bridge_directories") &&
    (message.includes("Could not find the table") ||
      message.includes("does not exist"))
  );
}

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
    if (error) {
      // Keep the Session console available during a migration-first rolling
      // deployment. Once PostgREST sees the new table, the polling query will
      // begin returning its inventory without a Web redeploy.
      if (isMissingDirectoryInventorySchema(error)) return [];
      throw mapDatabaseError(error);
    }
    return data ?? [];
  });
  return { directories };
}

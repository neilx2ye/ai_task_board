import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getPublicSupabaseEnv, getSupabaseSecretKey } from "@/lib/env";
import type { Database } from "@/lib/types/database";

let adminClient: ReturnType<typeof createClient<Database>> | undefined;

export function createAdminClient() {
  if (adminClient) return adminClient;
  const env = getPublicSupabaseEnv();
  adminClient = createClient<Database>(env.url, getSupabaseSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "X-Client-Info": "ai-task-board-server" } },
  });
  return adminClient;
}

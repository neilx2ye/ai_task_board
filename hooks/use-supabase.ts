"use client";

import { useMemo } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/types/database";

/**
 * NEXT_PUBLIC_* 变量在构建期内联，可在客户端安全地判断是否已配置。
 * 只认新的 Publishable Key；未配置时不创建客户端，
 * 界面展示“尚未配置 Supabase”状态。
 */
export const isSupabaseConfigured: boolean = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);

export function useSupabase(): SupabaseClient<Database> | null {
  return useMemo(() => {
    if (!isSupabaseConfigured) return null;
    try {
      return createClient();
    } catch {
      return null;
    }
  }, []);
}

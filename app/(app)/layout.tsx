"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { AppSidebar, MobileNav } from "@/components/app-nav";
import { NotConfigured } from "@/components/not-configured";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useRealtimeWorkspace } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { isSupabaseConfigured } from "@/hooks/use-supabase";

/** 登录后挂载 Realtime 订阅，断线重连与变更时失效查询缓存。 */
function RealtimeSync() {
  const { data } = useWorkspace();
  useRealtimeWorkspace(data?.workspace?.id);
  return null;
}

function AuthSplash() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6" role="status">
      <div className="flex w-full max-w-sm flex-col gap-3">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const auth = useAuth();

  useEffect(() => {
    if (auth.status === "anonymous") router.replace("/login");
  }, [auth.status, router]);

  if (!isSupabaseConfigured) return <NotConfigured />;
  if (auth.status !== "authenticated") return <AuthSplash />;

  return (
    <div className="flex min-h-dvh">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6">
          {children}
        </main>
      </div>
      <RealtimeSync />
    </div>
  );
}

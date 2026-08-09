"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BotIcon,
  CableIcon,
  CircleHelpIcon,
  KanbanSquareIcon,
  LogOutIcon,
} from "lucide-react";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/components/utils";

const NAV_ITEMS = [
  { href: "/sessions", label: "会话与上下文", icon: BotIcon },
  { href: "/board", label: "会话任务流", icon: KanbanSquareIcon },
  { href: "/connections", label: "AI 连接", icon: CableIcon },
  { href: "/help", label: "帮助", icon: CircleHelpIcon },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <>
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </>
  );
}

function BrandAndWorkspace() {
  const { data } = useWorkspace();
  return (
    <div className="flex flex-col gap-0.5 px-3">
      <span className="text-sm font-semibold tracking-tight">AI Task Board</span>
      <span className="truncate text-xs text-muted-foreground">
        {data?.workspace?.name ?? "工作区"}
      </span>
    </div>
  );
}

function UserFooter() {
  const auth = useAuth();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const email =
    auth.status === "authenticated" ? (auth.session.user.email ?? "已登录") : "";

  return (
    <div className="flex items-center gap-2 px-3">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {email}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await auth.signOut();
            router.replace("/login");
          })
        }
      >
        <LogOutIcon />
        退出
      </Button>
    </div>
  );
}

/** 桌面端侧边导航。 */
export function AppSidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col gap-4 border-r border-border bg-card py-5 md:flex">
      <BrandAndWorkspace />
      <nav aria-label="主导航" className="flex flex-1 flex-col gap-1 px-2">
        <NavLinks />
      </nav>
      <UserFooter />
    </aside>
  );
}

/** 移动端顶部导航条。 */
export function MobileNav() {
  return (
    <div className="sticky top-0 z-20 flex flex-col gap-2 border-b border-border bg-card/95 px-4 py-3 backdrop-blur md:hidden">
      <BrandAndWorkspace />
      <nav aria-label="主导航" className="flex gap-1 overflow-x-auto">
        <NavLinks />
      </nav>
    </div>
  );
}

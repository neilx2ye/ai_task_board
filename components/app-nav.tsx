"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BotIcon,
  CableIcon,
  CircleHelpIcon,
  FolderTreeIcon,
  LogOutIcon,
  NotebookPenIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/components/utils";

const NAV_ITEMS = [
  { href: "/sessions", label: "会话与上下文", icon: BotIcon },
  { href: "/planning", label: "任务规划", icon: NotebookPenIcon },
  { href: "/files", label: "文件预览", icon: FolderTreeIcon },
  { href: "/connections", label: "AI 连接", icon: CableIcon },
  { href: "/help", label: "帮助", icon: CircleHelpIcon },
] as const;

function NavLinks({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
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
            aria-label={collapsed ? label : undefined}
            title={collapsed ? label : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              collapsed && "justify-center px-0",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className={cn(collapsed && "sr-only")}>{label}</span>
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

function UserFooter({ collapsed = false }: { collapsed?: boolean }) {
  const auth = useAuth();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const email =
    auth.status === "authenticated" ? (auth.session.user.email ?? "已登录") : "";

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3",
        collapsed && "justify-center px-2",
      )}
    >
      {collapsed ? null : (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {email}
        </span>
      )}
      <Button
        variant="ghost"
        size={collapsed ? "icon" : "sm"}
        className={cn(collapsed && "size-9")}
        aria-label={collapsed ? "退出登录" : undefined}
        title={collapsed ? "退出登录" : undefined}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await auth.signOut();
            router.replace("/login");
          })
        }
      >
        <LogOutIcon />
        {collapsed ? null : "退出"}
      </Button>
    </div>
  );
}

/** 桌面端侧边导航。 */
export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      aria-label="应用导航侧边栏"
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col gap-4 border-r border-border bg-card py-5 transition-[width] duration-200 md:flex",
        collapsed ? "w-16" : "w-56",
      )}
    >
      <div
        className={cn(
          "flex items-start gap-2",
          collapsed ? "justify-center px-2" : "justify-between pr-2",
        )}
      >
        {collapsed ? null : <BrandAndWorkspace />}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9"
          aria-controls="app-main-navigation"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "展开主导航栏" : "折叠主导航栏"}
          title={collapsed ? "展开导航栏" : "折叠导航栏"}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
        </Button>
      </div>
      <nav
        id="app-main-navigation"
        aria-label="主导航"
        className="flex flex-1 flex-col gap-1 px-2"
      >
        <NavLinks collapsed={collapsed} />
      </nav>
      <UserFooter collapsed={collapsed} />
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

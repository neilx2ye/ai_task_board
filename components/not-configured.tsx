import { Card, CardContent } from "@/components/ui/card";

const MISSING_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];

/**
 * 未配置 Supabase 环境变量时的全屏占位状态。
 * 只在确实缺少 NEXT_PUBLIC 配置时展示，不伪造任何业务数据。
 */
export function NotConfigured() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col gap-4 p-6">
          <h1 className="text-lg font-semibold">尚未配置 Supabase</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            当前环境缺少以下环境变量，无法连接 Supabase，因此无法登录或加载看板数据：
          </p>
          <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
            {MISSING_VARS.map((name) => (
              <li key={name}>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {name}
                </code>
              </li>
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">
            请参照项目根目录的
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">
              .env.example
            </code>
            在 <code className="rounded bg-muted px-1.5 py-0.5 text-xs">.env.local</code>
            中填入 Supabase 项目的配置，然后重启开发服务器。
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

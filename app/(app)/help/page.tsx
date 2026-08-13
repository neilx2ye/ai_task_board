import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRightIcon,
  CableIcon,
  CircleHelpIcon,
  BotIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import { HELP_ACTIONS, HELP_SECTIONS } from "@/components/help-content";
import { TASK_STATUS_META } from "@/components/task-meta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/utils";
import type { TaskStatus } from "@/lib/types/database";

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle id={`${id}-title`} className="text-base">
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </section>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function CopyableCodeBlock({
  copyLabel,
  children,
}: {
  copyLabel: string;
  children: string;
}) {
  return (
    <div className="relative">
      <div className="absolute top-1.5 right-1.5">
        <CopyButton text={children} label={copyLabel} />
      </div>
      <CodeBlock>{children}</CodeBlock>
    </div>
  );
}

function Step({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums"
      >
        {index}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      </div>
    </li>
  );
}

function StatusRow({
  status,
  label,
  description,
}: {
  status: TaskStatus;
  label?: string;
  description: string;
}) {
  const meta = TASK_STATUS_META[status];
  return (
    <li className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <Badge className={cn("w-fit shrink-0", meta.badgeClass)}>
        {label ?? meta.label}
      </Badge>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </li>
  );
}

function FaqItem({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-border">
      <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex w-full items-center justify-between gap-2">
          {question}
          <span
            aria-hidden
            className="text-muted-foreground transition-transform group-open:rotate-90"
          >
            ›
          </span>
        </span>
      </summary>
      <div className="px-3 pb-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

const ACTION_ICONS = [BotIcon, CableIcon] as const;

export default function HelpPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <CircleHelpIcon className="size-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">帮助中心</h1>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          当你准备在一台新设备上安装和配置 Bridge 时，请按下面的顺序完成本机准备、
          连接创建、Bridge 启动和网页验证。新设备只需能访问 AI Task Board，
          不需要克隆或运行看板项目。
        </p>
      </header>

      <nav aria-label="帮助目录" className="flex flex-wrap gap-2">
        {HELP_SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <Section
        id="getting-started"
        title="当我准备在一台新设备上安装和配置 Bridge 时，应该要怎么做？"
      >
        <ol className="flex flex-col gap-4">
          <Step index={1} title="准备新设备和 Codex">
            安装 Node.js 18 或更高版本以及兼容的 Codex CLI，并使用准备运行 Bridge
            的同一个操作系统用户完成 Codex 登录。确认该用户可以访问目标工作目录，
            且设备可以通过 HTTPS 访问 AI Task Board。
          </Step>
          <Step index={2} title="为这台设备创建 AI 连接">
            打开
            <Link
              href="/connections"
              className="mx-1 font-medium text-foreground underline underline-offset-4"
            >
              「AI 连接」
            </Link>
            ，创建一个 Codex 连接。连接令牌
            <strong className="text-foreground">只显示一次</strong>
            ，请立即复制并妥善保存；丢失后只能轮换生成新令牌，旧令牌同时失效。
          </Step>
          <Step index={3} title="确定工作目录和权限边界">
            准备项目在新设备上的绝对路径。默认的
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              CODEX_THREAD_SCOPE=cwd
            </code>
            只管理工作目录完全匹配的顶层 thread；除非明确需要跨项目发现，否则不要改为
            <code className="mx-1 rounded bg-muted px-1 text-xs">all</code>。
            如果任务不需要完整文件和网络访问，请把权限模式设为
            <code className="mx-1 rounded bg-muted px-1 text-xs">safe</code>。
          </Step>
          <Step index={4} title="在新设备上启动 Bridge">
            使用
            <a
              href="#codex-bridge"
              className="mx-1 font-medium text-foreground underline underline-offset-4"
            >
              下方启动命令
            </a>
            ，替换看板地址、一次性连接令牌和工作目录后运行。命令必须由拥有本机
            Codex 登录与工作区的用户执行；同一台设备和 Connection 只运行一个 Bridge。
          </Step>
          <Step index={5} title="回到网页完成配置并验证">
            Bridge 上线后，在「AI 连接 → Bridge 设置」确认实际配置，再到
            <Link
              href="/sessions"
              className="mx-1 font-medium text-foreground underline underline-offset-4"
            >
              「会话与上下文」
            </Link>
            检查“设备 → 工作目录 → Thread”是否出现。没有现有 thread 时，可以在已上报的
            工作目录下新建一个 Thread，再发送一条测试消息确认 AI 回复能够回传。
          </Step>
          <Step index={6} title="确认可用后配置常驻运行">
            固定 Bridge 包版本，并使用 systemd、launchd 或其他本机进程管理器负责
            开机启动和异常重启。连接令牌应通过 Secret 管理器或权限受限的环境文件注入，
            不要写入仓库、服务文件、截图或共享日志。
          </Step>
        </ol>
      </Section>

      <Section id="codex-bridge" title="Codex Bridge（自动执行通道）">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Bridge 是运行在 Codex 设备上的常驻 companion。一个进程代表一台设备和一个
          AI Connection，通过 stdio 启动本机 Codex App Server，并为每个允许的本地
          thread 同步独立会话；只有 AI 回复会近实时显示在网页控制台。
        </p>
        <CopyableCodeBlock copyLabel="复制 Bridge 启动命令">{`AI_TASK_BOARD_URL='https://task.neilx.online' \\
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
CODEX_WORKING_DIRECTORY='/absolute/path/to/project' \\
CODEX_THREAD_SCOPE='cwd' \\
CODEX_BRIDGE_PERMISSION_MODE='danger-full-access' \\
CODEX_BRIDGE_APPROVAL_MODE='accept' \\
CODEX_BRIDGE_WEB_CONFIG='true' \\
CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES='true' \\
CODEX_BRIDGE_ALLOW_HISTORY_SYNC='true' \\
CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES='true' \\
CODEX_BRIDGE_MAX_HISTORY_TURNS='50' \\
npx --yes ai-task-board-codex-bridge@0.9.0`}</CopyableCodeBlock>
        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            必须在拥有该 Codex 登录、持久化 thread 和可写工作区的同一用户环境中运行；
            不要在 Next.js 看板服务进程里启动 App Server。
          </li>
          <li>
            同一设备/Connection 只运行一个 Bridge。不同 thread 可以并行，但不要同时用
            Codex TUI、IDE 或另一 Bridge 写入同一个 thread。
          </li>
          <li>
            npm 包不会自动安装系统服务；长期运行时请固定包版本，并使用 systemd、
            launchd 或其他进程管理器负责开机启动和异常重启。
          </li>
          <li>
            本机显式允许 Web 配置后，Workspace Owner 可以在“AI 连接 → Bridge 设置”
            动态启停、切换标题与历史同步，并调整 thread/并发/历史上限。Bridge 0.8
            额外设置 <code>CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES=true</code>
            后，还可在这里管理项目名称、稳定 key 与设备上的绝对工作路径。
          </li>
          <li>
            未授权 Web 路径管理时，仍用 <code>CODEX_WORKING_DIRECTORIES</code> 在设备配置
            多个精确 cwd。无论目录来自设备启动配置还是网页期望值，新建 Thread 都只把
            Bridge 已验证并上报的目录 key 返回设备，不能在单条命令中注入任意路径。
          </li>
          <li>
            Bridge 通过认证 SSE 接收不含任务数据的近实时唤醒，再用 REST
            原子领取；SSE 断线时从默认 5 秒逐步退避到 60 秒轮询，并持续尝试重连。
          </li>
          <li>
            SSE 保活和任务心跳属于控制面，不会发送给 Codex 或占用模型上下文；
            心跳只刷新在线时间或租约，也不会写入对话与任务事件。
          </li>
          <li>
            看板不同步思考、命令、工具调用或用量；经设备与网页双重授权后，
            也只补录最近完成 turn 的 AI 最终回复。
          </li>
          <li>
            0.8 保留 Web Thread 管理和同 turn 结构化问答；仍不支持网页逐次审批、
            可靠的运行中 steer/interrupt。默认 <code>danger-full-access</code>
            不启用 sandbox，默认 <code>accept</code> 会在设备端自动同意与当前活跃 turn
            关联的受支持请求，无需网页确认；组合使用会在当前 OS 用户权限范围内无沙箱执行，
            属于高风险配置。
            需要限制为 thread cwd、禁止网络时请选 <code>safe</code>；
            <code>inherit</code> 不发送覆盖并沿用本机 Codex 设置，边界未知时也应视为高风险。
          </li>
        </ul>
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          请通过受保护的环境变量或 Secret 管理器注入连接令牌，不要把真实令牌写入命令、
          仓库或共享日志。示例中的值都是占位符。
        </p>
      </Section>

      <Section id="task-status" title="任务状态说明">
        <ul className="flex flex-col gap-3">
          <StatusRow
            status="inbox"
            description="迁移前留下的未绑定任务。它不会被 AI 自主认领，需要人工指定会话。"
          />
          <StatusRow
            status="ready"
            description="依赖已全部完成，正在等待指定会话接收。"
          />
          <StatusRow
            status="running"
            label="执行中"
            description="目标会话已接收（claimed）或正在执行（running）。任务与会话租约绑定。"
          />
          <StatusRow
            status="waiting_user"
            description="AI 正在等你回答。Bridge 0.6 的结构化问题会显示为选择框，并保留原 turn 与 claim；旧 REST/MCP 纯文字提问仍会结束租约，回复后回到原会话队列。"
          />
          <StatusRow
            status="completed"
            description="已完成。父任务在全部有效子任务完成后自动完成。"
          />
        </ul>
        <p className="text-sm leading-relaxed text-muted-foreground">
          其他状态会在相关任务和会话中显示：
          <Badge className={cn("mx-1", TASK_STATUS_META.blocked.badgeClass)}>
            已阻塞
          </Badge>
          表示存在未完成依赖；
          <Badge className={cn("mx-1", TASK_STATUS_META.failed.badgeClass)}>
            已失败
          </Badge>
          表示执行失败、需要处理；
          <Badge className={cn("mx-1", TASK_STATUS_META.cancelled.badgeClass)}>
            已取消
          </Badge>
          表示已取消且不可恢复。
        </p>
      </Section>

      <Section id="ai-integration" title="AI 接入最小示例">
        <p className="text-sm leading-relaxed text-muted-foreground">
          AI 客户端通过 REST API 接入。所有请求都需要连接令牌；除注册会话外的
          任务操作还需要会话 ID；所有写请求必须使用唯一幂等键。
        </p>
        <CodeBlock>{`# 1) 注册会话（幂等）
POST /api/ai/sessions/register
Authorization: Bearer atb_...        # 连接令牌（只显示一次）
Idempotency-Key: <唯一键>

{ "name": "Claude Research", "platform": "claude",
  "model": "...", "capabilities": ["web_search"] }

# 2) 空闲时持续发送会话心跳
POST /api/ai/sessions/presence
Authorization: Bearer atb_...
X-AI-Session-ID: <session_id>
Idempotency-Key: <每次心跳的唯一键>

{}

# 3) 读取这个会话的下一项预留任务
POST /api/ai/tasks/claim-next
Authorization: Bearer atb_...
X-AI-Session-ID: <session_id>        # 注册返回的会话 ID
Idempotency-Key: <唯一键>

{ "lease_seconds": 900 }             # 不会扫描其他会话或未绑定任务`}</CodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          执行过程中用
          <code className="mx-1 rounded bg-muted px-1 text-xs">report-progress</code>
          回传进度，用
          <code className="mx-1 rounded bg-muted px-1 text-xs">request-user-input</code>
          向你提问，完成后调用
          <code className="mx-1 rounded bg-muted px-1 text-xs">complete</code> 或
          <code className="mx-1 rounded bg-muted px-1 text-xs">complete-and-claim-next</code>
          。心跳接口可延长租约；租约过期后仍只有原目标会话可以重新接收，改派需要用户明确操作。
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          高频心跳仍校验幂等键格式，但不会保存幂等响应或生成心跳事件；空的
          <code className="mx-1 rounded bg-muted px-1 text-xs">claim-next</code>
          也不会落幂等记录。只有真实领取和其他业务写操作保留可重放结果。
        </p>
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          连接令牌只在创建或轮换时显示一次，服务端只保存其哈希。请勿把令牌、
          SUPABASE_SECRET_KEY 提交到仓库或发送到公开渠道。
        </p>
      </Section>

      <Section id="attachments" title="附件">
        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            任务详情页的「结果与附件」区可以上传文件，单个文件最大
            <strong className="text-foreground"> 50 MiB</strong>
            ，存储在私有 Bucket 中。
          </li>
          <li>
            下载通过短期签名 URL 完成，有效期
            <strong className="text-foreground"> 60 秒</strong>
            ，点击「下载」时自动获取并打开。
          </li>
          <li>
            已取消的任务不能上传新附件，但仍可查看和下载已有附件。
          </li>
        </ul>
      </Section>

      <Section id="faq" title="常见问题">
        <div className="flex flex-col gap-2">
          <FaqItem question="为什么看不到会话或任务？">
            先在 CLI / APP 注册一个持续心跳的会话，并在「会话与上下文」的
            Thread 管理器中将它显示到侧边栏。从会话预留任务，或让会话用
            report-current 同步已开始的工作后，Thread 条目会显示当前任务状态。
          </FaqItem>
          <FaqItem question="无法登录或收不到验证邮件？">
            请确认使用注册时的邮箱和密码。当前开发项目已在 Supabase 中关闭邮箱
            验证，注册后可直接登录；如果你连接的是自己开启邮箱验证的项目，则需要
            先完成邮件验证。
          </FaqItem>
          <FaqItem question="AI 为什么接收不到预留任务？">
            常见原因：任务没有分配给当前会话；还有未完成依赖；任务要求的能力不在会话
            能力列表中；该会话已持有一个进行中的任务；任务是只作聚合展示的父任务；
            或者本机 Bridge / 手动 REST 主循环没有运行。
          </FaqItem>
          <FaqItem question="什么是租约过期？">
            会话接收任务时会生成 60~3600 秒的租约（默认 900 秒），AI 通过心跳续期。
            租约过期说明会话可能已失联；任务不会被别的 AI 抢走。你可以手动释放后再明确改派。
          </FaqItem>
          <FaqItem question="页面会自动刷新吗？">
            会。页面通过 Supabase Realtime 订阅任务、消息、事件、会话活动、会话和附件的
            变化并自动更新；断线重连后会补拉遗漏事件，另有 30 秒低频轮询兜底，
            不需要手动刷新。
          </FaqItem>
          <FaqItem question="密钥和令牌应该如何保管？">
            SUPABASE_SECRET_KEY 只存在于服务端环境，浏览器永远不会接触；
            连接令牌和领取令牌只在创建时显示一次，服务端只保存哈希。任何令牌
            都不要写入代码、日志或公开渠道，泄露后立即在「AI 连接」页轮换或撤销。
          </FaqItem>
        </div>
      </Section>

      <nav aria-label="快速操作" className="grid gap-3 sm:grid-cols-2">
        {HELP_ACTIONS.map((action, index) => {
          const Icon = ACTION_ICONS[index] ?? ArrowRightIcon;
          return (
            <Card key={action.href} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-2 p-4">
                <Icon className="size-5 text-primary" />
                <p className="text-sm font-medium">{action.label}</p>
                <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </p>
                <Button variant="outline" size="sm" className="w-fit" asChild>
                  <Link href={action.href}>
                    打开
                    <ArrowRightIcon />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </nav>
    </div>
  );
}

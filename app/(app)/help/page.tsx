import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRightIcon,
  CableIcon,
  CircleHelpIcon,
  KanbanSquareIcon,
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

const ACTION_ICONS = [BotIcon, CableIcon, KanbanSquareIcon] as const;

export default function HelpPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <CircleHelpIcon className="size-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">帮助中心</h1>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          AI Task Board 是会话优先的任务控制台：外部 AI 会话（ChatGPT、Claude、
          Codex、Gemini 或自定义 Agent）先在 CLI / APP 中建立上下文，再通过 REST
          API 或 MCP 同步工作；Web Console 只向指定的存活会话预留任务、查看结果和回复问题。
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

      <Section id="getting-started" title="快速上手">
        <ol className="flex flex-col gap-4">
          <Step index={1} title="创建 AI 连接并保存一次性令牌">
            在「AI 连接」页创建连接。连接令牌
            <strong className="text-foreground">只显示一次</strong>
            ，请立即复制并妥善保存；丢失后只能轮换生成新令牌，旧令牌同时失效。
          </Step>
          <Step index={2} title="在 CLI / APP 建立上下文并注册会话">
            先把任务背景和约束交给 AI，再用稳定的对话引用注册会话。空闲时也要持续
            发送心跳；两分钟没有活动的会话不会被视为存活。
          </Step>
          <Step index={3} title="同步当前任务或定向预留">
            CLI / APP 已开始的工作用 report-current 同步；如果从 Web 创建任务，请在
            会话卡片点击「预留任务」。新任务必须绑定具体存活会话，不进入公共池。
          </Step>
          <Step index={4} title="执行与回复">
            会话读取自己的预留队列并持续回传进度；当它请求补充信息时，任务进入
            「等我回复」，你的回复会让任务回到原会话的队列。
          </Step>
        </ol>
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
            description="AI 提出了一个需要你回答的问题。在任务详情页回复后，任务回到原会话的预留队列。"
          />
          <StatusRow
            status="completed"
            description="已完成。父任务在全部有效子任务完成后自动完成。"
          />
        </ul>
        <p className="text-sm leading-relaxed text-muted-foreground">
          其他状态不占用固定列，通过任务流顶部的筛选器显示：
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
          使用 MCP 的客户端（如 Codex）请直接阅读下方
          <a
            href="#mcp-integration"
            className="mx-1 text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            MCP 接入
          </a>
          章节，其中的工具集与 REST 一一对应。
        </p>
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          连接令牌只在创建或轮换时显示一次，服务端只保存其哈希。请勿把令牌、
          SUPABASE_SECRET_KEY 提交到仓库或发送到公开渠道。
        </p>
      </Section>

      <Section id="mcp-integration" title="MCP 接入（Codex 等 MCP 客户端）">
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <strong>看板不会自动启动或唤醒 Codex 子 Agent。</strong>
            MCP 客户端必须主动连接端点并调用或轮询工具；仅在看板上创建或预留任务，
            不会有任何 AI 自动开始工作。
          </span>
        </p>

        <p className="text-sm leading-relaxed text-muted-foreground">
          公网端点为
          <code className="mx-1 rounded bg-muted px-1 text-xs break-all">
            https://task.neilx.online/api/mcp
          </code>
          ，是无状态的 MCP Streamable HTTP 服务：所有请求都必须携带
          <code className="mx-1 rounded bg-muted px-1 text-xs">
            Authorization: Bearer atb_...
          </code>
          连接令牌；服务端返回
          <code className="mx-1 rounded bg-muted px-1 text-xs">application/json</code>
          ，<strong className="text-foreground">不签发 Mcp-Session-Id</strong>
          ，因此每次调用都是独立请求，需重复发送鉴权头。端点支持
          initialize、notifications/initialized、ping、tools/list 与 tools/call。
        </p>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Connection 与 Session 的区别</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <strong className="text-foreground">Connection Token</strong>
            属于整个 AI 环境或 MCP 连接，可以固定在全局 MCP 配置中；
            <strong className="text-foreground">Session</strong>
            属于具体的一次对话、线程或 Agent 上下文，同一个 Connection 下可以
            （并且通常会）存在多个 Session。因此共享的 Codex CLI、IDE、
            ChatGPT desktop MCP 配置
            <strong className="text-foreground">绝不要固定 X-AI-Session-ID</strong>
            ，否则所有对话的工作都会被错误归到同一个 Session；会话 ID 应由每个
            对话上下文各自持有，并随每次工具调用传递。
          </p>
        </div>

        <ol className="flex flex-col gap-4">
          <Step index={1} title="创建一次性连接令牌">
            <span className="flex flex-col items-start gap-2">
              <span>
                在「AI 连接」页创建连接并立即保存
                <code className="mx-1 rounded bg-muted px-1 text-xs">atb_...</code>
                令牌；它只显示一次，是建立 MCP 连接的鉴权凭证。
              </span>
              <Button variant="outline" size="sm" asChild>
                <Link href="/connections">
                  打开 AI 连接
                  <ArrowRightIcon />
                </Link>
              </Button>
            </span>
          </Step>
          <Step index={2} title="调用 register_session 注册会话">
            每个新对话或 Agent 上下文首次使用时调用
            <code className="mx-1 rounded bg-muted px-1 text-xs">register_session</code>
            ，并提供该上下文稳定且唯一的
            <code className="mx-1 rounded bg-muted px-1 text-xs">external_conversation_ref</code>
            ；同一 Connection + external_conversation_ref 重连会恢复同一 Session。
            从返回的
            <code className="mx-1 rounded bg-muted px-1 text-xs break-all">
              result.structuredContent.data.session.id
            </code>
            取得会话 ID。
          </Step>
          <Step index={3} title="在对话上下文中保存并传递会话 ID">
            把会话 ID 保存在当前对话或 Agent 上下文中，之后每次工具调用都在
            <code className="mx-1 rounded bg-muted px-1 text-xs">arguments.session_id</code>
            中传该对话自己的 Session ID（除 register_session 外，服务端 schema
            已公开 session_id 字段）。不要把会话 ID 写进共享的全局 MCP 配置。
          </Step>
          <Step index={4} title="领取与执行">
            之后按下方主循环领取预留任务、回传进度并完成。
          </Step>
        </ol>

        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            除
            <code className="mx-1 rounded bg-muted px-1 text-xs">register_session</code>
            外，<strong className="text-foreground">所有工具都需要会话 ID</strong>
            ，在每次调用的 arguments.session_id 中传递（专用 Worker 的请求头例外见文末说明）。
          </li>
          <li>
            除
            <code className="mx-1 rounded bg-muted px-1 text-xs">get_task</code> 和
            <code className="mx-1 rounded bg-muted px-1 text-xs">get_task_updates</code>
            外，<strong className="text-foreground">所有工具都需要唯一的
            idempotency_key</strong>；对同一逻辑操作重试时必须复用原 key。
          </li>
        </ul>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Codex 配置（全局，不含会话 ID）</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            全局的
            <code className="mx-1 rounded bg-muted px-1 text-xs">~/.codex/config.toml</code>
            只固定端点和令牌，会话 ID 由每个对话在工具 arguments 中传递：
          </p>
          <CopyableCodeBlock copyLabel="复制 Codex 配置">{`# ~/.codex/config.toml
# 先设置环境变量：
#   export ATB_CONNECTION_TOKEN='atb_...'   # 一次性连接令牌

[mcp_servers.ai_task_board]
url = "https://task.neilx.online/api/mcp"
bearer_token_env_var = "ATB_CONNECTION_TOKEN"

# 不要在这里配置 X-AI-Session-ID：这份配置被所有对话共享，
# 固定会话头会让所有对话归到同一个 Session。
# 每个对话首次使用时调用 register_session，之后在每次
# 工具调用的 arguments.session_id 中传自己的会话 ID。`}</CopyableCodeBlock>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Codex CLI、IDE 扩展与 ChatGPT desktop 共用同一 Codex host 的这份配置；
            保存后可用
            <code className="mx-1 rounded bg-muted px-1 text-xs">codex mcp list</code>
            或会话内的
            <code className="mx-1 rounded bg-muted px-1 text-xs">/mcp</code>
            命令检查连接状态。注意 ChatGPT 网页版不会读取这份本地配置。
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">通用 Streamable HTTP 客户端</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            其他 MCP Host 可使用等价的 JSON 配置（部分 Host 把
            <code className="mx-1 rounded bg-muted px-1 text-xs">type</code> 命名为
            <code className="mx-1 rounded bg-muted px-1 text-xs">streamable-http</code>
            ）。全局配置同样只固定令牌，请用自己的连接令牌替换占位符，优先使用
            Host 的 Secret 插值能力：
          </p>
          <CopyableCodeBlock copyLabel="复制通用 MCP 配置">{`{
  "mcpServers": {
    "ai-task-board": {
      "type": "http",
      "url": "https://task.neilx.online/api/mcp",
      "headers": {
        "Authorization": "Bearer atb_REPLACE_ME"
      }
    }
  }
}`}</CopyableCodeBlock>
          <p className="text-sm leading-relaxed text-muted-foreground">
            会话 ID 不写入此配置：每个对话首次调用 register_session 取得后，
            在每次工具调用的 arguments.session_id 中传递。
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">工具清单（16 个，与 REST 一一对应）</h3>
          <ul className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
            <li>
              <Badge variant="secondary" className="mb-1">会话</Badge>
              <p>
                <code className="mx-1 rounded bg-muted px-1 text-xs">register_session</code>
                注册或刷新会话（无需会话 ID）；
                <code className="mx-1 rounded bg-muted px-1 text-xs">heartbeat_session</code>
                空闲会话存活心跳。
              </p>
            </li>
            <li>
              <Badge variant="secondary" className="mb-1">领取与查询</Badge>
              <p>
                <code className="mx-1 rounded bg-muted px-1 text-xs">claim_next_task</code>
                领取本会话预留队列的下一项；
                <code className="mx-1 rounded bg-muted px-1 text-xs">claim_task</code>
                领取指定任务；
                <code className="mx-1 rounded bg-muted px-1 text-xs">get_task</code>
                读取任务详情；
                <code className="mx-1 rounded bg-muted px-1 text-xs">get_task_updates</code>
                按事件游标读取更新（这两个只读工具无需幂等键）。
              </p>
            </li>
            <li>
              <Badge variant="secondary" className="mb-1">执行与沟通</Badge>
              <p>
                <code className="mx-1 rounded bg-muted px-1 text-xs">report_current_task</code>
                同步外部已开始的工作；
                <code className="mx-1 rounded bg-muted px-1 text-xs">create_subtasks</code>
                原子拆分子任务；
                <code className="mx-1 rounded bg-muted px-1 text-xs">report_progress</code>
                回传进度；
                <code className="mx-1 rounded bg-muted px-1 text-xs">post_task_message</code>
                发送任务消息；
                <code className="mx-1 rounded bg-muted px-1 text-xs">request_user_input</code>
                向用户提问；
                <code className="mx-1 rounded bg-muted px-1 text-xs">heartbeat</code>
                延长任务租约。
              </p>
            </li>
            <li>
              <Badge variant="secondary" className="mb-1">收尾</Badge>
              <p>
                <code className="mx-1 rounded bg-muted px-1 text-xs">complete_task</code>
                完成并提交结果；
                <code className="mx-1 rounded bg-muted px-1 text-xs">complete_task_and_claim_next</code>
                完成并原子领取下一项；
                <code className="mx-1 rounded bg-muted px-1 text-xs">fail_task</code>
                标记失败；
                <code className="mx-1 rounded bg-muted px-1 text-xs">release_task</code>
                释放回队列。完整字段约束以 tools/list 返回为准。
              </p>
            </li>
          </ul>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">推荐主循环</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <code className="mx-1 rounded bg-muted px-1 text-xs">heartbeat_session</code>
            保持会话存活 →
            <code className="mx-1 rounded bg-muted px-1 text-xs">claim_next_task</code>
            领取预留任务 → 执行中用
            <code className="mx-1 rounded bg-muted px-1 text-xs">report_progress</code>
            回传进度或
            <code className="mx-1 rounded bg-muted px-1 text-xs">post_task_message</code>
            发消息 → 用
            <code className="mx-1 rounded bg-muted px-1 text-xs">heartbeat</code>
            续租 → 完成后调用
            <code className="mx-1 rounded bg-muted px-1 text-xs">complete_task_and_claim_next</code>
            进入下一项。
          </p>
          <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              调用 request_user_input 后任务进入「等我回复」并结束当前租约，
              <strong>旧 claim token 立即失效</strong>
              ；用户回复后必须重新 claim 才能继续执行。
            </span>
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">高级：X-AI-Session-ID 请求头（仅限专用 Worker）</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            服务端也接受
            <code className="mx-1 rounded bg-muted px-1 text-xs">X-AI-Session-ID</code>
            请求头，但它只适合
            <strong className="text-foreground">一个独立进程永久绑定一个 Session 的
            专用 Worker</strong>。共享或全局 MCP 环境不要配置它：当请求头与
            arguments.session_id 同时存在时<strong className="text-foreground">请求头优先</strong>，
            固定的请求头会覆盖每次调用传入的 arguments.session_id，导致所有
            对话都被归到同一个 Session。
          </p>
        </div>
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
          <FaqItem question="看板为什么是空的？">
            先在 CLI / APP 注册一个持续心跳的会话，再从会话卡片预留任务；或者让会话
            用 report-current 同步已开始的工作。如果任务存在但看不到，检查顶部的其他状态筛选器。
          </FaqItem>
          <FaqItem question="无法登录或收不到验证邮件？">
            请确认使用注册时的邮箱和密码。当前开发项目已在 Supabase 中关闭邮箱
            验证，注册后可直接登录；如果你连接的是自己开启邮箱验证的项目，则需要
            先完成邮件验证。
          </FaqItem>
          <FaqItem question="AI 为什么接收不到预留任务？">
            常见原因：任务没有分配给当前会话；还有未完成依赖；任务要求的能力不在会话
            能力列表中；该会话已持有一个进行中的任务；或者任务是只作聚合展示的父任务。
          </FaqItem>
          <FaqItem question="什么是租约过期？">
            会话接收任务时会生成 60~3600 秒的租约（默认 900 秒），AI 通过心跳续期。
            租约过期说明会话可能已失联；任务不会被别的 AI 抢走。你可以手动释放后再明确改派。
          </FaqItem>
          <FaqItem question="看板会自动刷新吗？">
            会。页面通过 Supabase Realtime 订阅任务、消息、事件、会话和附件的
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

      <nav aria-label="快速操作" className="grid gap-3 sm:grid-cols-3">
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

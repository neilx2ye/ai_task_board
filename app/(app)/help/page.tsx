import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRightIcon,
  CableIcon,
  CircleHelpIcon,
  BotIcon,
  FolderTreeIcon,
  NotebookPenIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import {
  BRIDGE_INSTALL_PACKAGE,
  HELP_ACTIONS,
  HELP_SECTIONS,
} from "@/components/help-content";
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

const ACTION_ICONS = [BotIcon, CableIcon, NotebookPenIcon, FolderTreeIcon] as const;

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
          <Step index={1} title="准备新设备和 Agent CLI">
            安装 Node.js 18 或更高版本，以及这台设备要接入的 Agent CLI（Codex、Kimi
            Code、Antigravity CLI 1.1.8 及以上，或 Claude Code 的
            <code>claude-agent-acp</code> 适配器），并使用准备运行 Bridge 的同一个
            操作系统用户完成对应登录。确认该用户可以访问目标工作目录，且设备可以通过
            HTTPS 访问 AI Task Board。
          </Step>
          <Step index={2} title="为这台设备创建 AI 连接">
            打开
            <Link
              href="/connections"
              className="mx-1 font-medium text-foreground underline underline-offset-4"
            >
              「AI 连接」
            </Link>
            ，为一个系统用户创建
            <strong className="text-foreground">一个</strong>
            平台为「统一设备 Bridge」的连接：一个连接、一个 Token 即可承载该用户
            环境里的 Codex、Kimi Code、Antigravity 与 Claude Code 四种运行时。
            （只接入单个 Agent 时，也可以继续创建对应的单平台连接。）连接令牌
            <strong className="text-foreground">只显示一次</strong>
            ，请立即复制并妥善保存；丢失后只能轮换生成新令牌，旧令牌同时失效。
          </Step>
          <Step index={3} title="准备工作目录和权限边界">
            四个 Bridge 的工作目录都可以在安装完成后到「AI 连接 → Bridge 设置 /
            新建项目」用网页添加，交互安装不再询问目录（默认由 Web 管理）；自动化或
            前台部署需要本机固定白名单时，再通过各自前缀的
            <code>*_WORKING_DIRECTORY(S)</code> 环境变量填写绝对路径。Codex Bridge
            默认的
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              CODEX_THREAD_SCOPE=cwd
            </code>
            进一步限定只接管 cwd 完全匹配的既有顶层 thread；除非明确需要跨项目发现，
            否则不要改为
            <code className="mx-1 rounded bg-muted px-1 text-xs">all</code>。
            如果任务不需要完整文件和网络访问，Codex 请把权限模式设为
            <code className="mx-1 rounded bg-muted px-1 text-xs">safe</code>
            ；Kimi / Antigravity / Claude Code 保持安装器默认的拒绝额外权限即可。
          </Step>
          <Step index={4} title="在新设备上启动 Bridge">
            使用
            <a
              href="#codex-bridge"
              className="mx-1 font-medium text-foreground underline underline-offset-4"
            >
              下方统一的安装命令
            </a>
            。一个系统用户只需一个 Bridge：<code>setup</code> 一次只问 Board 地址
            （留空使用 <code>https://task.neilx.online</code>）、一个连接令牌和要
            启用的运行时（默认全部四种），然后安装并启动
            <strong className="text-foreground">唯一一个</strong>
            systemd 用户服务，四种运行时在该服务内并行常驻；<code>run all</code>
            在前台运行同一套运行时。后续如果版本新增了 Bridge 类型，再运行一次
            <code>setup</code> 即可并入现有服务，无需重新输入 Token。只要环境变量里
            提供了 <code>AI_TASK_BOARD_CONNECTION_TOKEN</code>（或设备已保存过
            Token），SSH 命令或 CI 脚本等非交互环境就直接执行，不再提问；交互式
            终端里 setup 每次都会重新询问 Token，留空保留现值、输入新值则替换。
            命令必须由拥有本机 Agent 登录与工作区的用户执行；安装器会为该用户配置服务，
            同一台设备和一个系统用户只运行一个统一 Bridge。
          </Step>
          <Step index={5} title="回到网页完成配置并验证">
            Bridge 上线后，可在「AI 连接 → Bridge 设置」核对实际配置；统一设备
            连接里可以为每个运行时分别选择并调整设置。Web 是唯一配置入口，安装后
            即可直接在网页管理；thread 标题上传与 Codex 历史同步在新连接上默认开启。
            再到
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
            Linux 交互式安装会创建并启动当前用户的 systemd user service；确认服务状态
            和日志正常，并按需启用 linger，确保用户未登录时仍能运行。连接令牌会保存到
            权限受限的环境文件中，不要把它写入仓库、截图或共享日志。systemd 托管的
            Bridge 默认开启自动升级（见
            <a
              href="#bridge-updates"
              className="mx-1 font-medium text-foreground underline underline-offset-4"
            >
              Bridge 升级与回滚
            </a>
            ）。
          </Step>
        </ol>
      </Section>

      <Section
        id="unified-bridge"
        title="统一设备 Bridge（一个服务、一个 Token）"
      >
        <p className="text-sm leading-relaxed text-muted-foreground">
          一个系统用户只需要一个 Bridge：<code>setup</code> 一次只询问 Board 地址、
          一个 Connection Token 和要启用的运行时（默认全部四种），然后安装并启动唯一
          一个 <code className="mx-1">ai-task-board-bridge.service</code>。
          supervisor 在这个服务里并行托管 Codex、Kimi、Antigravity 与 Claude Code
          四种运行时；<code>run all</code> 可以在前台运行同一套运行时。
        </p>
        <CopyableCodeBlock copyLabel="复制统一设备 Bridge 安装命令">
          {`npx --yes ${BRIDGE_INSTALL_PACKAGE} setup`}
        </CopyableCodeBlock>
        <CopyableCodeBlock copyLabel="复制统一设备 Bridge 前台启动命令">{`AI_TASK_BOARD_URL='https://task.neilx.online' \\
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
npx --yes ${BRIDGE_INSTALL_PACKAGE} run all`}</CopyableCodeBlock>
        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            「AI 连接」里新建平台为「统一设备 Bridge」的连接：一个连接、一个 Token
            即可承载四种运行时；只有部分 Agent 要接入时，也可以继续使用单平台连接。
          </li>
          <li>
            「Bridge 设置」会按运行时拆分：为统一连接打开设置后，先选择 Codex /
            Kimi / Antigravity / Claude Code，再调整对应的工作目录、上限与权限；
            Codex、Kimi、Antigravity 的套餐额度也会分别展示在连接卡片上。
          </li>
          <li>
            后续版本新增 Bridge 类型时，再运行一次 <code>setup</code> 即可把新运行时
            并入现有服务，保留已保存的 Token 与配置，不需要重新输入。
          </li>
          <li>
            四种运行时的设备配置（工作目录、上限、权限、审批策略与 Web 配置开关）
            统一写入同一个环境文件，安装时一次写入，Codex、Kimi、Antigravity 与
            Claude Code 各用自己前缀的变量读取同一份配置，不再分别提问。
          </li>
          <li>
            升级前装的四套独立 systemd 服务会自动停用，其环境配置会并入统一服务；
            旧版单平台连接与旧 Bridge 继续正常工作，无需改动。
          </li>
          <li>
            用 <code>AI_TASK_BOARD_BRIDGES</code> 可显式控制启用的运行时
            （如 <code>codex,kimi</code>，或 <code>all</code>）；未设置时统一服务
            默认启用全部四种。
          </li>
        </ul>
      </Section>

      <Section id="codex-bridge" title="Codex Bridge（自动执行通道）">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Bridge 是运行在 Codex 设备上的常驻 companion。在统一设备连接下，Codex
          只是同一个 systemd 服务里的一个运行时，与 Kimi、Antigravity、Claude Code
          共享一个 Connection Token；它通过 stdio 启动本机 Codex App Server，并为
          每个允许的本地 thread 同步独立会话；只有 AI 回复会近实时显示在网页控制台。
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Linux 推荐使用统一的交互式安装器。一个系统用户只需一个 Bridge：安装器只
          询问一次 Board 地址（留空使用
          <code>https://task.neilx.online</code>）、一个 Connection Token 与要启用
          的运行时（默认全部四种），然后创建
          <code className="ml-1">ai-task-board-bridge.service</code>
          这唯一一个 systemd user service，四种运行时在其中并行常驻。工作目录、
          thread/并发上限、权限与审批策略等其余配置默认由 Web 端管理（安装后到
          「AI 连接 → Bridge 设置 / 新建项目」添加，统一连接下每个运行时各有一套）。
          再次运行 setup 会把新加入的 Bridge 类型并入现有服务并保留 Token。只要提供了
          <code>AI_TASK_BOARD_CONNECTION_TOKEN</code>，SSH / CI 等非交互环境就
          直接按环境变量或已保存的 Token 运行，不再提问；交互式终端里 setup 每次
          都会重新询问 Token（留空保留现值、输入新值则替换）。<code>setup</code>
          写入 systemd 服务并立即启动，<code>run</code> 只在前台运行、npx 进程
          结束后 Bridge 随之下线：
        </p>
        <CopyableCodeBlock copyLabel="复制 Bridge 安装命令">
          {`npx --yes ${BRIDGE_INSTALL_PACKAGE} setup`}
        </CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          SSH 命令或 CI 脚本没有交互终端时，<code>setup codex</code> 同样读取环境变量
          直接安装并启动同一个 systemd 服务，不会在前台 npx 里运行；只有
          <code>AI_TASK_BOARD_CONNECTION_TOKEN</code> 是必填的，
          <code>AI_TASK_BOARD_URL</code> 可省略（默认
          <code>https://task.neilx.online</code>）：
        </p>
        <CopyableCodeBlock copyLabel="复制非交互式安装命令">{`AI_TASK_BOARD_URL='https://task.neilx.online' \\
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
npx --yes ${BRIDGE_INSTALL_PACKAGE} setup codex`}</CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          如需前台运行或自动化部署，也可以直接通过环境变量配置：
        </p>
        <CopyableCodeBlock copyLabel="复制 Bridge 前台启动命令">{`AI_TASK_BOARD_URL='https://task.neilx.online' \\
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
CODEX_WORKING_DIRECTORY='/absolute/path/to/project' \\
CODEX_THREAD_SCOPE='cwd' \\
CODEX_BRIDGE_PERMISSION_MODE='danger-full-access' \\
CODEX_BRIDGE_APPROVAL_MODE='accept' \\
CODEX_BRIDGE_MAX_HISTORY_TURNS='50' \\
npx --yes ${BRIDGE_INSTALL_PACKAGE} run codex`}</CopyableCodeBlock>
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
            Linux 上的 <code>setup</code> 会安装并启动当前用户的
            <code className="ml-1">ai-task-board-bridge.service</code>。可使用
            <code className="mx-1">systemctl --user status ai-task-board-bridge.service</code>
            查看状态；其他系统请使用对应的本机进程管理器。
          </li>
          <li>
            Workspace Owner 安装后就能在“AI 连接 → Bridge 设置”动态启停、切换标题
            与历史同步，并调整权限模式、审批模式与 thread/并发/历史上限；这套远程
            配置在 Codex、Kimi、
            Antigravity 与 Claude Code 连接上均可使用（历史同步仅 Codex 支持），
            且不需要任何设备端授权开关。thread 标题上传与 Codex 历史同步对新连接
            默认开启；权限与审批模式只在 Codex 运行时开放网页选择（新连接默认
            “全权限（无沙箱）”与“自动通过”）。也可以在“Bridge 设置”里管理项目
            名称、稳定 key 与设备上的绝对工作路径，Bridge 会在应用前校验路径存在。
          </li>
          <li>
            未在网页启用目录管理时，仍用各自前缀的 <code>*_WORKING_DIRECTORIES</code>
            在设备配置多个精确 cwd。无论目录来自设备启动配置还是网页期望值，新建
            Thread 都只把 Bridge 已验证并上报的目录 key 返回设备，不能在单条命令中注入任意路径。
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
            当前版本支持 Web Thread 管理和同 turn 结构化问答转发；暂停命令可尽力中断
            运行中的 turn（一个轮询周期内生效），但仍不支持运行中 steer 与网页逐次审批。默认 <code>danger-full-access</code>
            不启用 sandbox，默认 <code>accept</code> 会在设备端自动同意与当前活跃 turn
            关联的受支持请求，无需网页确认；组合使用会在当前 OS 用户权限范围内无沙箱执行，
            属于高风险配置。
            需要限制为 thread cwd、禁止网络时请选 <code>safe</code>；
            <code>inherit</code> 不发送覆盖并沿用本机 Codex 设置，边界未知时也应视为高风险。
          </li>
          <li>
            「AI 连接」页可以看到每个 Bridge 的当前版本与 npm 最新版，并下发目标版本；
            systemd 托管的 Bridge 默认会自动升级，前台运行需手动重跑
            <code>setup</code>。详见
            <a
              href="#bridge-updates"
              className="mx-1 font-medium text-foreground underline underline-offset-4"
            >
              Bridge 升级与回滚
            </a>
            。
          </li>
        </ul>
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          请通过受保护的环境变量或 Secret 管理器注入连接令牌，不要把真实令牌写入命令、
          仓库或共享日志。示例中的值都是占位符。
        </p>
      </Section>

      <Section id="kimi-bridge" title="Kimi Bridge（Kimi Code ACP）">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Kimi Bridge 通过 Kimi ACP 连接真实的本机 Kimi Code Sessions，它不会把
          Kimi 伪装成 Codex 模型。使用统一设备 Bridge 时无需单独建连接：Kimi 只是
          同一个服务里的一个运行时，与其余运行时共用一个 Token；只接入 Kimi 时，
          也可以在「AI 连接」新建平台为 “Kimi Code” 的单平台连接，再由拥有 Kimi
          登录和目标工作区的同一系统用户安装。Kimi 运行时已内嵌在统一 Bridge 包中，
          不需要安装第二个 npm 包。
        </p>
        <CopyableCodeBlock copyLabel="复制 Kimi Bridge 安装命令">
          {`npx --yes ${BRIDGE_INSTALL_PACKAGE} setup kimi`}
        </CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          交互安装只询问 Board 地址与 Token；提供了
          <code>AI_TASK_BOARD_CONNECTION_TOKEN</code> 时，<code>setup kimi</code>
          直接非交互安装并启动 systemd 服务（SSH / CI 同样适用），
          <code>run kimi</code> 在前台运行。未提供
          <code>KIMI_WORKING_DIRECTORY</code> 时默认由 Web 端管理工作目录（安装后到
          「AI 连接 → Bridge 设置 / 新建项目」添加）。使用统一设备连接时，令牌就是
          那一个连接令牌；也可以继续使用独立的 Kimi Code 连接：
        </p>
        <CopyableCodeBlock copyLabel="复制 Kimi Bridge 前台启动命令">{`AI_TASK_BOARD_URL='https://task.neilx.online' \\
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
KIMI_WORKING_DIRECTORY='/absolute/path/to/project' \\
KIMI_BRIDGE_MODE='auto' \\
KIMI_BRIDGE_APPROVAL_MODE='accept' \\
npx --yes ${BRIDGE_INSTALL_PACKAGE} run kimi`}</CopyableCodeBlock>
        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            Bridge 会动态上报 Kimi ACP 返回的模型和 low/high/max 等思考强度；新建
            Session 与下一 Turn 的模型选择不会使用 Codex 兼容列表。
          </li>
          <li>
            可用 <code>KIMI_WORKING_DIRECTORIES</code> 配置多个精确 cwd 白名单；网页新建
            只发送稳定目录 key，不能注入任意本机路径。Kimi ACP 只能按目录发现本机
            Session，等价于固定的工作目录范围。目录清单可以直接在「Bridge 设置」里
            由 Web 维护，设备会校验路径存在，「新建项目」下发的目录不存在时由设备
            自动创建。
          </li>
          <li>
            Kimi ACP 支持新建和删除 Session，但当前没有可靠的改名方法，所以 Kimi
            连接会隐藏 Thread 改名入口；网页创建时填写的名称仍作为看板显示名保留。
          </li>
          <li>
            会话标题上传对新连接默认开启，可在「Bridge 设置」关闭；
            <code className="ml-1">KIMI_BRIDGE_INCLUDE_SESSION_TITLES=true</code>
            仅作为网页值生效前的启动默认。「Bridge 设置」可以直接动态启停、调整
            thread 数与并发上限；<code className="ml-1">KIMI_MAX_THREADS</code>
            只是网页值生效前的启动回退值。
          </li>
          <li>
            <code>KIMI_BRIDGE_MODE=yolo</code> 与
            <code className="ml-1">KIMI_BRIDGE_APPROVAL_MODE=accept</code>
            都会扩大自动执行范围。安装器默认拒绝额外权限，请只在可信工作区显式开启。
          </li>
          <li>
            Linux 安装器把 Kimi 运行时并入当前用户的统一服务
            <code className="mx-1">ai-task-board-bridge.service</code>（旧版独立
            服务 <code>ai-task-board-kimi-bridge.service</code> 会自动停用）。
            Board Connection Token 会从 <code>kimi acp</code> 子进程环境移除；同一 OS
            用户下的进程仍不构成强隔离，敏感部署应使用独立 UID 或 token proxy。
          </li>
        </ul>
      </Section>

      <Section id="antigravity-bridge" title="Antigravity Bridge（Google Antigravity CLI）">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Antigravity Bridge 通过 Antigravity CLI 官方的 headless
          <code>stream-json</code> 接口驱动本机 <code>agy</code>，它不读取 Google
          未公开的会话数据库。使用统一设备 Bridge 时无需单独建连接；只接入
          Antigravity 时，也可以在「AI 连接」新建平台为 “Antigravity” 的单平台
          连接，再由拥有 Antigravity 登录和目标工作区的同一系统用户安装。运行时已
          内嵌在统一 Bridge 包中，不需要安装第二个 npm 包。
        </p>
        <CopyableCodeBlock copyLabel="复制 Antigravity Bridge 安装命令">
          {`npx --yes ${BRIDGE_INSTALL_PACKAGE} setup antigravity`}
        </CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          交互安装只询问 Board 地址与 Token；提供了
          <code>AI_TASK_BOARD_CONNECTION_TOKEN</code> 时，<code>setup antigravity</code>
          直接非交互安装并启动 systemd 服务（SSH / CI 同样适用），
          <code>run antigravity</code> 在前台运行。未提供
          <code>ANTIGRAVITY_WORKING_DIRECTORY</code> 时默认由 Web 端管理工作目录
          （安装后到「AI 连接 → Bridge 设置 / 新建项目」添加）。使用统一设备连接时，
          令牌就是那一个连接令牌；也可以继续使用独立的 Antigravity 连接：
        </p>
        <CopyableCodeBlock copyLabel="复制 Antigravity Bridge 前台启动命令">{`AI_TASK_BOARD_URL='https://task.neilx.online' \\
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
ANTIGRAVITY_WORKING_DIRECTORY='/absolute/path/to/project' \\
ANTIGRAVITY_BRIDGE_MODE='auto' \\
ANTIGRAVITY_BRIDGE_APPROVAL_MODE='accept' \\
npx --yes ${BRIDGE_INSTALL_PACKAGE} run antigravity`}</CopyableCodeBlock>
        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            需要 Antigravity CLI 1.1.8 或更新版本（<code>agy update</code> 升级）。
            每个 Board Thread 对应一个本地会话绑定；首个任务创建真实 conversation，
            后续 Turn 通过 <code>--conversation</code> 续接同一上下文。
          </li>
          <li>
            Bridge 会从 <code>agy models</code> 动态上报模型和 low/medium/high
            思考强度；新建 Thread 与下一 Turn 的模型选择不会使用 Codex 兼容列表。
          </li>
          <li>
            可用 <code>ANTIGRAVITY_WORKING_DIRECTORIES</code> 配置多个精确 cwd
            白名单；网页新建只发送稳定目录 key，不能注入任意本机路径。目录清单也
            可以直接在「Bridge 设置」里由 Web 维护，设备会校验路径存在，「新建项目」
            下发的目录不存在时由设备自动创建。
          </li>
          <li>
            agy headless 没有公开的改名与历史读取接口，因此 Antigravity 连接会隐藏
            Thread 改名，删除 Thread 只移除 Bridge 绑定、保留本机会话文件，也不会导入
            TUI 中既有的会话。Bridge 只管理自己创建的 Thread，清单保存在本机注册表
            （可用 <code>ANTIGRAVITY_REGISTRY_FILE</code> 换路径）。
          </li>
          <li>
            「Bridge 设置」可以直接动态启停、调整 thread 数与并发上限；
            <code className="ml-1">ANTIGRAVITY_MAX_THREADS</code>
            只是网页值生效前的启动回退值。单次执行时长可用
            <code className="ml-1">ANTIGRAVITY_PRINT_TIMEOUT</code>
            （如 5m、90s，默认按租约自动预留余量）。
          </li>
          <li>
            <code>ANTIGRAVITY_BRIDGE_APPROVAL_MODE=accept</code> 会向 agy 传入
            <code className="ml-1">--dangerously-skip-permissions</code>，自动批准全部
            工具调用，属于高风险配置。安装器默认拒绝额外权限；可用
            <code className="ml-1">ANTIGRAVITY_BRIDGE_SANDBOX=true</code>
            额外启用 agy 终端沙箱。
          </li>
          <li>
            Linux 安装器把 Antigravity 运行时并入当前用户的统一服务
            <code className="mx-1">ai-task-board-bridge.service</code>（旧版独立
            服务 <code>ai-task-board-antigravity-bridge.service</code> 会自动停用）。
            Board Connection Token 会从 <code>agy</code> 子进程环境移除；同一 OS
            用户下的进程仍不构成强隔离，敏感部署应使用独立 UID 或 token proxy。
          </li>
        </ul>
      </Section>

      <Section
        id="claude-code-bridge"
        title="Claude Code Bridge（claude-agent-acp）"
      >
        <p className="text-sm leading-relaxed text-muted-foreground">
          Claude Code Bridge 通过 Anthropic 官方的
          <code className="mx-1">@agentclientprotocol/claude-agent-acp</code>
          ACP 适配器驱动本机 Claude Code Sessions，它不会把 Claude 伪装成 Codex
          模型。使用统一设备 Bridge 时无需单独建连接；只接入 Claude Code 时，也
          可以在「AI 连接」新建平台为 “Claude Code” 的单平台连接，再由拥有 Claude
          登录和目标工作区的同一系统用户安装。运行时已内嵌在统一 Bridge 包中，
          官方 ACP 适配器也会在启用 Claude Code 时由 <code>setup</code> 自动安装
          到用户数据目录并配置好 <code>CLAUDE_BINARY</code>，无需再单独执行
          <code>npm install -g</code>。
        </p>
        <CopyableCodeBlock copyLabel="复制 Claude Code Bridge 安装命令">
          {`npx --yes ${BRIDGE_INSTALL_PACKAGE} setup claude`}
        </CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          订阅用户请先用同一系统用户运行 <code>claude login</code>；API / 自定义
          网关用户请设置 <code>ANTHROPIC_API_KEY</code>、
          <code>ANTHROPIC_AUTH_TOKEN</code> 或 <code>CLAUDE_CODE_OAUTH_TOKEN</code>。
          交互安装只询问 Board 地址与 Token；提供了
          <code>AI_TASK_BOARD_CONNECTION_TOKEN</code> 时，
          <code>setup claude</code> 直接非交互安装并启动 systemd 服务，
          <code>run claude</code> 在前台运行。未提供
          <code>CLAUDE_WORKING_DIRECTORY</code> 时默认由 Web 端管理工作目录。令牌
          可以是统一设备连接的那一个令牌，也可以来自独立的 Claude Code 连接：
        </p>
        <CopyableCodeBlock copyLabel="复制 Claude Code Bridge 前台启动命令">{`AI_TASK_BOARD_URL='https://task.neilx.online' \\
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
CLAUDE_WORKING_DIRECTORY='/absolute/path/to/project' \\
CLAUDE_BRIDGE_MODE='default' \\
CLAUDE_BRIDGE_APPROVAL_MODE='accept' \\
npx --yes ${BRIDGE_INSTALL_PACKAGE} run claude`}</CopyableCodeBlock>
        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            Bridge 会从 Claude ACP 的会话配置项动态上报可用模型（Default / Sonnet /
            Opus / Haiku 等）与思考强度；新建 Session 与下一 Turn 的模型选择不会使用
            Codex 兼容列表。
          </li>
          <li>
            可用 <code>CLAUDE_WORKING_DIRECTORIES</code> 配置多个精确 cwd 白名单；
            网页新建只发送稳定目录 key，不能注入任意本机路径。目录清单也可以直接
            在「Bridge 设置」里由 Web 维护，设备会校验路径存在，「新建项目」下发的
            目录不存在时由设备自动创建。
          </li>
          <li>
            Claude ACP 支持新建、恢复和删除 Session，但没有可靠的改名接口，因此
            Claude Code 连接会隐藏 Thread 改名入口；网页创建时填写的名称仍作为看板
            显示名保留。
          </li>
          <li>
            Goal 模式使用 Claude Code 原生的
            <code className="ml-1">/goal</code> 会话目标：开启时在下一 Turn 前设置
            目标，关闭时发送 <code>/goal clear</code>，需要较新的
            <code>claude-agent-acp</code> 适配器。
          </li>
          <li>
            「Bridge 设置」可以直接动态启停、调整 Session 数与并发上限；
            <code className="ml-1">CLAUDE_MAX_THREADS</code>
            只是网页值生效前的启动回退值。
          </li>
          <li>
            <code>CLAUDE_BRIDGE_MODE=bypass-permissions</code> 会跳过大部分权限检查，
            <code className="ml-1">CLAUDE_BRIDGE_APPROVAL_MODE=accept</code>
            会自动批准与看板任务关联的权限请求，两者都扩大自动执行范围。安装器默认
            拒绝额外权限，请只在可信工作区显式开启。
          </li>
          <li>
            Linux 安装器把 Claude Code 运行时并入当前用户的统一服务
            <code className="mx-1">ai-task-board-bridge.service</code>（旧版独立
            服务 <code>ai-task-board-claude-bridge.service</code> 会自动停用）。
            Board Connection Token 会从 <code>claude-agent-acp</code> 子进程环境
            移除；同一 OS 用户下的进程仍不构成强隔离，敏感部署应使用独立 UID 或
            token proxy。
          </li>
        </ul>
      </Section>

      <Section id="bridge-updates" title="Bridge 升级与回滚">
        <p className="text-sm leading-relaxed text-muted-foreground">
          「AI 连接」页会展示每个连接当前上报的版本与 npm 上的最新版（统一设备连接
          下四种运行时共享同一包版本）。Workspace Owner 可以为单个连接下发目标版本，
          也可以批量「全部升级」。远程升级默认开启：
          systemd 托管的 Bridge（<code>setup</code> 安装）在下次配置交换后自动从 npm
          下载目标版本、校验完整性、冒烟检查新版本可启动，再重写 systemd 单元并自动
          重启到新版本。看板只传递版本号、从不托管代码包，目标版本必须真实存在于 npm
          且高于当前版本。统一设备 Bridge 下四个运行时共用同一个 npm 包：只有升级
          leader 运行时会执行下载与冒烟检查，随后整个 systemd 服务统一重启到新版本。
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          升级失败时旧版本继续运行，错误会显示在「AI 连接 → Bridge 设置」；同一目标
          版本失败后不会立即重试。前台 <code>run</code> 的进程无法自动重启，因此不执行
          自更新，需要手动重跑安装命令（统一设备 Bridge 直接 <code>setup</code>；
          单平台 Codex 为例，Kimi / Antigravity / Claude Code 替换平台名）：
        </p>
        <CopyableCodeBlock copyLabel="复制手动升级命令">{`AI_TASK_BOARD_URL='https://task.neilx.online' \\
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \\
npx --yes ${BRIDGE_INSTALL_PACKAGE} setup`}</CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          旧版本目录会保留在
          <code>~/.local/share/ai-task-board/*-bridge/versions/&lt;版本&gt;/</code>，
          可随时回滚：编辑对应 systemd 单元的 <code>ExecStart</code>，把它指回旧版本的
          <code>dist/cli.js</code>，然后执行：
        </p>
        <CopyableCodeBlock copyLabel="复制回滚命令">{`systemctl --user daemon-reload
systemctl --user restart ai-task-board-bridge.service`}</CopyableCodeBlock>
        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            1.5.0 之前的版本没有内置更新器，那部分设备需要先手动升级一次；之后即可
            使用网页下发版本。
          </li>
          <li>
            升级只替换本机运行的 Bridge 代码，不改变 Board 端 schema/API；目标版本
            过旧或不存在时，网页会在下发前拒绝。
          </li>
          <li>
            自动升级依赖设备能访问 npm registry；设备配置了滞后镜像时，请等待镜像同步
            或改用官方 registry 后再重试。
          </li>
        </ul>
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
            description="AI 正在等你回答。Codex Bridge 转发的结构化问题会显示为选择框，并保留原 turn 与 claim（Kimi / Antigravity / Claude Code 通道暂不支持结构化问答）；REST/MCP 纯文字提问仍会结束租约，回复后回到原会话队列。"
          />
          <StatusRow
            status="paused"
            description="已暂停的任务不会被认领；暂停运行中任务会尽力中断设备上的 turn（最长约一个轮询周期）；恢复后回到原会话队列重新执行。"
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
          表示已取消且不可恢复。另外，Thread 完成任务后、在你打开查看前，
          侧栏会显示
          <Badge className="mx-1 border-amber-200 bg-amber-50 text-amber-800">
            待查看
          </Badge>
          ，点击打开 Thread 后转为
          <Badge className="mx-1 border-emerald-200 bg-emerald-50 text-emerald-700">
            已完成
          </Badge>
          。
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
            会。页面通过 Supabase Realtime 订阅任务、消息、事件、会话活动、会话、附件、
            Bridge 工作目录、历史同步和规划笔记等数据的变化并自动更新；断线重连后会补拉
            遗漏事件，另有 30 秒低频轮询兜底，不需要手动刷新。
          </FaqItem>
          <FaqItem question="为什么四个 Bridge 的环境变量数量差很多？">
            四者共享同一组 AI_TASK_BOARD_* 看板变量和各自前缀的工作目录白名单，也都有
            各自前缀的启动回退变量，远程配置统一由网页控制。差异来自
            Agent 能力面：Codex Bridge 要发现并接管本机已存在的 Codex threads，因此多出
            thread 范围（CODEX_THREAD_SCOPE / CODEX_THREAD_ID）、标题与历史同步
            等开关；Kimi（ACP）、Antigravity（agy headless）和 Claude Code
            （claude-agent-acp）由 Bridge 按需创建
            会话，没有可接管的本机清单，也就不需要这些变量。权限类变量则直接映射各自 CLI
            的原生模型：Codex 用沙箱加审批组合，Kimi 用 ACP mode，Antigravity 用
            --mode、--dangerously-skip-permissions 和 --sandbox，Claude Code 用
            ACP permission mode 与审批组合。
          </FaqItem>
          <FaqItem question="交互式安装会问哪些问题？">
            一个系统用户只安装一个 Bridge，交互式安装只问一次：Board 地址（留空使用
            https://task.neilx.online）、Connection Token 和要启用的运行时类型
            （默认 Codex、Kimi、Antigravity、Claude Code 全部四种）。每次运行
            setup 都会重新询问 Token：留空保留当前已保存的值，输入新值则替换
            （同一设备更换连接时无需改其他配置）；首次安装时必填。再次运行 setup
            会保留原 Token 与配置，只把新加入的 Bridge 类型并入现有服务。工作目录、
            thread/并发上限、权限与审批策略等其余配置统一写入同一份环境文件、覆盖
            四种运行时（含 Claude Code），也可在安装后到「AI 连接 → Bridge 设置 /
            新建项目」管理（统一连接下每个运行时各有一套）；SSH / CI 等非交互环境
            读取环境变量或已保存的 Token，不再提问。
          </FaqItem>
          <FaqItem question="Bridge 会自动升级吗？">
            会。systemd 托管的 Bridge（setup 安装）默认自动响应网页下发的目标版本：
            从 npm 下载、校验完整性、冒烟测试后重写单元并重启，失败则保留旧版并回报
            错误。统一设备 Bridge 下只有升级 leader 运行时执行下载，随后整个服务
            统一重启到新版本。前台 run 的进程无法自动重启，需要手动重跑 setup 升级。
            详见「Bridge 升级与回滚」章节。
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

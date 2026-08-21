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
            <code className="ml-1">ai-task-board-bridge.service</code>。服务停止后可用
            <code className="mx-1">systemctl --user start ai-task-board-bridge.service</code>
            重新启动，使用
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

      <Section id="ai-integration" title="AI 客户端 API 接入细则">
        <p className="text-sm leading-relaxed text-muted-foreground">
          AI 客户端通过 REST API 接入，基地址就是部署后的看板地址（例如
          <code>https://task.neilx.online</code>）。客户端只持有「AI 连接」创建时
          一次性展示的 <code>atb_</code> 连接令牌；服务端由令牌解析出连接与
          Workspace，请求体不要提交 <code>workspace_id</code>。所有请求都使用
          HTTPS JSON：成功响应统一是 <code>{`{ "data": ... }`}</code> 信封，失败
          统一是 <code>{`{ "error": { "code", "message" } }`}</code> 信封，只暴露
          稳定的业务错误码，不包含 SQL、Supabase 原始错误或内部堆栈。
        </p>
        <CodeBlock>{`# 通用请求头
Authorization: Bearer atb_<connection_token>
X-AI-Session-ID: <session_id>            # 注册后所有会话级命令必填
Idempotency-Key: <client>/<op>/<uuid>    # 写请求必填，1–200 字符
Content-Type: application/json

# 最小主循环（保存并使用响应中的 session.id / task.claim_token）
POST /api/ai/sessions/register          # { name, platform, capabilities, ... }
POST /api/ai/sessions/presence          # 每分钟一次，body {}
POST /api/ai/tasks/claim-next           # { "lease_seconds": 900 }
POST /api/ai/sessions/heartbeat         # { task_id, claim_token, lease_seconds }
POST /api/ai/tasks/report-progress      # { task_id, claim_token, progress_* }
POST /api/ai/tasks/complete-and-claim-next`}</CodeBlock>
        <h3 className="text-sm font-medium">客户端必须遵守的规则</h3>
        <ul className="list-inside list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>
            <strong className="text-foreground">保活与离线阈值。</strong>
            空闲或等待回复时也要至少每分钟 POST
            <code className="mx-1 rounded bg-muted px-1 text-xs">sessions/presence</code>
            （body 为 <code className="rounded bg-muted px-1 text-xs">{`{}`}</code>）
            刷新存活；两分钟没有会话活动，网页会把会话视为离线并停止新的预留。执行中的
            租约用
            <code className="mx-1 rounded bg-muted px-1 text-xs">sessions/heartbeat</code>
            续期。两类心跳仍校验幂等键格式，但属于自然幂等刷新：不缓存响应、不写任务
            事件、不进 AI 上下文，同键不同心跳内容也不会冲突。
          </li>
          <li>
            <strong className="text-foreground">SSE 唤醒流（可选）。</strong>
            常驻 Worker 可 GET
            <code className="mx-1 rounded bg-muted px-1 text-xs">sessions/wake</code>
            （Accept: text/event-stream）建立认证 SSE。服务端只发
            <code className="mx-1 rounded bg-muted px-1 text-xs">ready</code>、
            <code className="mx-1 rounded bg-muted px-1 text-xs">wake</code>、
            <code className="mx-1 rounded bg-muted px-1 text-xs">degraded</code>、
            <code className="mx-1 rounded bg-muted px-1 text-xs">reconnect</code>
            帧与注释保活，绝不携带任务标题、正文或令牌；收到提示后仍必须用
            <code className="mx-1 rounded bg-muted px-1 text-xs">claim-next</code>
            原子领取，SSE 只是可能重复或遗漏的低延迟提示，数据库与 REST 才是权威
            状态，请保留低频轮询作为断线兜底。
          </li>
          <li>
            <strong className="text-foreground">领取范围。</strong>
            <code className="mx-1 rounded bg-muted px-1 text-xs">claim-next</code>
            只考虑分配给当前会话、能力匹配且依赖已完成的
            <code className="rounded bg-muted px-1 text-xs">ready</code> 叶子任务，
            按优先级降序、创建时间升序原子接收；不会扫描其他会话或未绑定任务。没有
            预留任务时返回 task 为 null，且该空结果不写持久幂等表。
            <code className="mx-1 rounded bg-muted px-1 text-xs">lease_seconds</code>
            可选 60–3600，默认 900。
          </li>
          <li>
            <strong className="text-foreground">claim_token。</strong>
            只在领取类响应中出现一次，回传进度、续租、消息、拆分、问答、完成、失败或
            释放都必须携带。租约过期、任务暂停或改派后令牌立即失效（403
            INVALID_CLAIM_TOKEN），此时应把任务视为已被接管，停止重试并丢弃本地 turn
            状态，重新领取并取得新令牌，不要复用旧令牌。
          </li>
          <li>
            <strong className="text-foreground">幂等键。</strong>
            每个写请求一个唯一键（1–200 字符，建议
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              &lt;client&gt;/&lt;operation&gt;/&lt;uuid&gt;
            </code>
            ）。同键同内容可安全重试：真实领取的响应保留 24 小时、可完全重放并返回
            同一个 claim_token；同键不同内容返回 409 IDEMPOTENCY_CONFLICT。例外：
            presence / heartbeat 只校验格式；claim-next 的空结果不缓存；历史导入用
            运行实例 fence 与 external_ref 去重、不读取该键。
          </li>
          <li>
            <strong className="text-foreground">请求体上限。</strong>
            普通 AI 命令默认 512 KiB，活动上报 768 KiB、历史导入 640 KiB、Inventory
            同步 1152 KiB；超限返回 413 PAYLOAD_TOO_LARGE。
          </li>
          <li>
            <strong className="text-foreground">回复上传。</strong>
            会话时间线固定只保存
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              assistant_message
            </code>
            ；为兼容旧适配器，reasoning / command / file_change / mcp_tool /
            web_search / plan / error / usage / status 会被接受但以 suppressed:true
            忽略。content 1–100,000 字符，data 为 JSON 对象且不超过 256 KiB，
            external_ref 必填（最长 500 字符）并在会话内稳定唯一：同 ref 同内容重试
            安全，同 ref 改内容会被拒绝。
          </li>
          <li>
            <strong className="text-foreground">拆分与问答。</strong>
            <code className="mx-1 rounded bg-muted px-1 text-xs">create-subtasks</code>
            一次提交 1–100 个子任务，依赖用批次内唯一的
            <code className="rounded bg-muted px-1 text-xs">client_ref</code> 表达；
            未知引用、自依赖或依赖环会让整批回滚，成功后父任务清除领取、满足依赖的
            叶子进入 ready。纯文字
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              request-user-input
            </code>
            会把任务置为 waiting_user 并结束租约，回复后任务回到 ready、由原会话
            重新领取；Codex 结构化问题改用 user-input-requests 注册 + poll（1–3 个
            问题），任务保持 running、保留原 claim_token 与租约，答案不写入公开任务
            消息。
          </li>
          <li>
            <strong className="text-foreground">结束任务。</strong>
            推荐
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              complete-and-claim-next
            </code>
            原子完成并领取下一项（返回 next_task 与新 claim_token）；只完成用
            complete，失败用 fail（reason 必填），主动放弃用 release。AI REST 不接收
            二进制附件，随完成命令提交 HTTPS external_url，或引用已上传的私有
            storage_path（二者只能给一个，最多 100 个附件）。
          </li>
          <li>
            <strong className="text-foreground">查询与增量。</strong>
            GET
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              tasks/:taskId
            </code>
            读取详情；GET
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              tasks/:taskId/updates
            </code>
            用不可变事件 ID 游标补拉变化（after + limit 1–500，把响应的 next_cursor
            持久化作为下次 after）；GET
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              artifacts/:artifactId/download
            </code>
            返回 300 秒签名 URL 或外部 URL。
          </li>
          <li>
            <strong className="text-foreground">Web 接口区分。</strong>
            <code className="mx-1 rounded bg-muted px-1 text-xs">/api/user/*</code>
            是给已登录网页使用的，走 Supabase Auth Cookie 鉴权，不接受 AI 连接令牌；
            AI 客户端应始终使用
            <code className="mx-1 rounded bg-muted px-1 text-xs">/api/ai/*</code>。
          </li>
        </ul>
        <h3 className="text-sm font-medium">端点速查</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">方法</th>
                <th className="py-2 pr-3 font-medium">路径</th>
                <th className="py-2 font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/sessions/register</code>
                </td>
                <td className="py-1.5">注册或按 external_conversation_ref 幂等更新会话</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/sessions/presence</code>
                </td>
                <td className="py-1.5">空闲会话保活（建议每分钟）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/sessions/heartbeat</code>
                </td>
                <td className="py-1.5">领取租约续期（task_id + claim_token）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>GET</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/sessions/wake</code>
                </td>
                <td className="py-1.5">认证 SSE 唤醒提示（无任务数据）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/sessions/sync</code>
                </td>
                <td className="py-1.5">Bridge 上报设备 Inventory / 模型 / 配额 / 版本</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/sessions/history</code>
                </td>
                <td className="py-1.5">Codex 历史追加导入（分页、按 external_ref 去重）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/sessions/activity</code>
                </td>
                <td className="py-1.5">回传 AI 回复（仅 assistant_message 落库）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/claim-next</code>
                </td>
                <td className="py-1.5">领取下一项预留任务，返回 task + claim_token</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/claim</code>
                </td>
                <td className="py-1.5">领取指定任务（task_id + lease_seconds）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/report-progress</code>
                </td>
                <td className="py-1.5">回传进度（percent 为 0–100 整数或 null）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/report-current</code>
                </td>
                <td className="py-1.5">同步外部已开始的任务（external_task_ref 去重）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/messages</code>
                </td>
                <td className="py-1.5">追加任务消息</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/create-subtasks</code>
                </td>
                <td className="py-1.5">一次性拆分子任务（client_ref 表达依赖）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/request-user-input</code>
                </td>
                <td className="py-1.5">纯文字提问（进入 waiting_user 并结束租约）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/user-input-requests</code>
                </td>
                <td className="py-1.5">注册结构化问题（任务保持 running、保留 claim）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/user-input-requests/:requestId/poll</code>
                </td>
                <td className="py-1.5">轮询结构化问题的答案</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/complete</code>
                </td>
                <td className="py-1.5">完成任务（可携带结果与附件引用）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/complete-and-claim-next</code>
                </td>
                <td className="py-1.5">完成并原子领取下一项（返回 next_task）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/fail</code>
                </td>
                <td className="py-1.5">标记失败（reason 必填）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/release</code>
                </td>
                <td className="py-1.5">主动释放当前领取</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>GET</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/:taskId</code>
                </td>
                <td className="py-1.5">任务详情与关系</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>GET</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/tasks/:taskId/updates</code>
                </td>
                <td className="py-1.5">增量事件（after 游标 + limit 1–500）</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>GET</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/artifacts/:artifactId/download</code>
                </td>
                <td className="py-1.5">附件下载签名 URL</td>
              </tr>
              <tr className="align-top">
                <td className="py-1.5 pr-3"><code>POST</code></td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <code>/api/ai/thread-commands/*</code>
                  <br />
                  <code>/api/ai/file-commands/*</code>
                </td>
                <td className="py-1.5">
                  Bridge 设备命令：Thread / 文件命令的 claim 与 complete，只需连接令牌
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3 className="text-sm font-medium">稳定错误码</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">错误码</th>
                <th className="py-2 pr-3 font-medium">HTTP</th>
                <th className="py-2 font-medium">处理建议</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>TASK_NOT_FOUND</code></td>
                <td className="py-1.5 pr-3">404</td>
                <td className="py-1.5">停止重试并刷新任务引用</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>TASK_NOT_READY</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">重新查询依赖或等待任务恢复</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>TASK_ALREADY_CLAIMED</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">不要执行该任务，刷新当前会话状态</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>LEASE_EXPIRED</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">停止使用旧令牌，重新领取</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>INVALID_CLAIM_TOKEN</code></td>
                <td className="py-1.5 pr-3">403</td>
                <td className="py-1.5">丢弃令牌并重新领取，不要记录令牌</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>DEPENDENCY_CYCLE</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">修正整批依赖后用新幂等键重试</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>SESSION_NOT_AUTHORIZED</code></td>
                <td className="py-1.5 pr-3">403</td>
                <td className="py-1.5">检查连接、会话 ID 与任务定向指派</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>CAPABILITY_MISMATCH</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">由用户明确改派到满足能力的存活会话</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>INVALID_STATE_TRANSITION</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">刷新当前状态后决定下一命令</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>IDEMPOTENCY_CONFLICT</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">不要复用 Key；核对第一次请求</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>VERSION_CONFLICT</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">刷新 Bridge 配置版本并重新确认修改</td>
              </tr>
              <tr className="border-b border-border align-top">
                <td className="py-1.5 pr-3"><code>BRIDGE_INSTANCE_CONFLICT</code></td>
                <td className="py-1.5 pr-3">409</td>
                <td className="py-1.5">停止重复 Bridge；等待旧实例退出或租约到期</td>
              </tr>
              <tr className="align-top">
                <td className="py-1.5 pr-3">
                  <code>AUTHENTICATION_REQUIRED</code>
                </td>
                <td className="py-1.5 pr-3">401</td>
                <td className="py-1.5">连接令牌缺失、无效或已撤销</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <code className="mx-1 rounded bg-muted px-1 text-xs">400 INVALID_REQUEST</code>
          表示 JSON / Zod 校验失败，应修正请求后换新幂等键重试；
          <code className="mx-1 rounded bg-muted px-1 text-xs">413 PAYLOAD_TOO_LARGE</code>
          表示请求体超限；
          <code className="mx-1 rounded bg-muted px-1 text-xs">500 INTERNAL_ERROR</code>
          可以使用同一个幂等键有限退避重试。
        </p>
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          连接令牌只在创建或轮换时显示一次，服务端只保存其哈希。请勿把令牌、
          SUPABASE_SECRET_KEY 提交到仓库或发送到公开渠道，生产环境请使用客户端的
          Secret Store。
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

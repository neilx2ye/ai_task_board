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
            Code，或 Antigravity CLI 1.1.8 及以上），并使用准备运行 Bridge 的同一个
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
            ，按设备上的 Agent 创建平台匹配的连接（Codex、Kimi Code 或 Antigravity，
            一台设备运行多个 Bridge 时每个平台各建一个）。连接令牌
            <strong className="text-foreground">只显示一次</strong>
            ，请立即复制并妥善保存；丢失后只能轮换生成新令牌，旧令牌同时失效。
          </Step>
          <Step index={3} title="准备工作目录和权限边界">
            Codex Bridge 的工作目录可以在安装完成后到「AI 连接 → Bridge
            设置 / 新建项目」用网页添加，安装时无需预先准备；需要本机固定白名单时再填写
            绝对路径。Kimi / Antigravity 仍需要在设备上配置各自白名单
            （*_WORKING_DIRECTORY(S)）。Codex Bridge 默认的
            <code className="mx-1 rounded bg-muted px-1 text-xs">
              CODEX_THREAD_SCOPE=cwd
            </code>
            进一步限定只接管 cwd 完全匹配的既有顶层 thread；除非明确需要跨项目发现，
            否则不要改为
            <code className="mx-1 rounded bg-muted px-1 text-xs">all</code>。
            如果任务不需要完整文件和网络访问，Codex 请把权限模式设为
            <code className="mx-1 rounded bg-muted px-1 text-xs">safe</code>
            ；Kimi / Antigravity 保持安装器默认的拒绝额外权限即可。
          </Step>
          <Step index={4} title="在新设备上启动 Bridge">
            使用
            <a
              href="#codex-bridge"
              className="mx-1 font-medium text-foreground underline underline-offset-4"
            >
              下方交互式安装命令
            </a>
            ，按提示选择要安装的 Bridge 并填写看板地址和一次性连接令牌；Codex 的工作目录
            可以稍后在网页添加。SSH 命令或 CI 脚本（无交互终端）也可以直接提供环境变量
            运行 <code>setup</code>，同样会安装 systemd 服务。
            命令必须由拥有本机 Agent 登录与工作区的用户执行；安装器会为该用户配置服务，
            同一台设备和 Connection 只运行一个 Bridge。
          </Step>
          <Step index={5} title="回到网页完成配置并验证">
            Bridge 上线后，可在「AI 连接 → Bridge 设置」核对实际配置。Kimi /
            Antigravity 需要先在本机设置
            <code className="mx-1">KIMI_BRIDGE_WEB_CONFIG=true</code>（Antigravity
            为 <code>ANTIGRAVITY_BRIDGE_WEB_CONFIG=true</code>）才会应用 Web 期望值，
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
            权限受限的环境文件中，不要把它写入仓库、截图或共享日志。
          </Step>
        </ol>
      </Section>

      <Section id="codex-bridge" title="Codex Bridge（自动执行通道）">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Bridge 是运行在 Codex 设备上的常驻 companion。一个进程代表一台设备和一个
          AI Connection，通过 stdio 启动本机 Codex App Server，并为每个允许的本地
          thread 同步独立会话；只有 AI 回复会近实时显示在网页控制台。
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Linux 推荐使用统一的交互式安装器。它会先询问安装 Codex、Kimi、Antigravity，
          还是组合，再以执行命令的当前用户创建对应的 systemd user service。选择
          Codex 后会继续收集 Codex 配置。工作目录不再强制填写，默认由 Web 端管理
          （安装后到「AI 连接 → Bridge 设置 / 新建项目」添加）：
        </p>
        <CopyableCodeBlock copyLabel="复制 Bridge 安装命令">
          {`npx --yes ${BRIDGE_INSTALL_PACKAGE} setup`}
        </CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          SSH 命令或 CI 脚本没有交互终端时，<code>setup codex</code> 会读取环境变量
          直接安装并启动同一个 systemd 服务，不会在前台 npx 里运行：
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
CODEX_BRIDGE_WEB_CONFIG='true' \\
CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES='true' \\
CODEX_BRIDGE_ALLOW_HISTORY_SYNC='true' \\
CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES='true' \\
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
            本机显式允许 Web 配置后，Workspace Owner 可以在“AI 连接 → Bridge 设置”
            动态启停、切换标题与历史同步，并调整 thread/并发/历史上限；这套远程配置
            在 Codex、Kimi 与 Antigravity 连接上均可使用（Kimi / Antigravity 分别用
            <code className="ml-1">KIMI_BRIDGE_WEB_CONFIG=true</code> /
            <code className="ml-1">ANTIGRAVITY_BRIDGE_WEB_CONFIG=true</code> 开启，
            且暂不支持历史同步与 Web 工作目录管理）。设备额外设置
            <code>CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES=true</code>
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
            当前版本支持 Web Thread 管理和同 turn 结构化问答转发；仍不支持网页逐次审批、
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

      <Section id="kimi-bridge" title="Kimi Bridge（Kimi Code ACP）">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Kimi Bridge 是独立的设备 companion，通过 Kimi ACP 连接真实的本机 Kimi
          Code Sessions。它不会把 Kimi 伪装成 Codex 模型；请先在「AI 连接」新建平台为
          “Kimi Code”的连接，再由拥有 Kimi 登录和目标工作区的同一系统用户安装。Kimi
          运行时已内嵌在统一 Bridge 包中，不需要安装第二个 npm 包。
        </p>
        <CopyableCodeBlock copyLabel="复制 Kimi Bridge 安装命令">
          {`npx --yes ${BRIDGE_INSTALL_PACKAGE} setup kimi`}
        </CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          无交互终端时，提供以下变量运行 <code>setup kimi</code> 同样会安装并启动
          systemd 服务；未提供 <code>KIMI_WORKING_DIRECTORY</code> 时默认由 Web 端管理
          工作目录（安装后到「AI 连接 → Bridge 设置 / 新建项目」添加）；也可以显式使用
          <code>run kimi</code> 在前台运行。令牌必须来自独立的 Kimi Code 连接：
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
            Session，等价于固定的工作目录范围。设备设置
            <code className="ml-1">KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION=true</code>
            （交互安装选择 Web 管理目录时自动写入）后，目录清单也可以直接在「Bridge
            设置」里由 Web 维护，设备会校验路径存在，「新建项目」下发的目录不存在时
            由设备自动创建。
          </li>
          <li>
            Kimi ACP 支持新建和删除 Session，但当前没有可靠的改名方法，所以 Kimi
            连接会隐藏 Thread 改名入口；网页创建时填写的名称仍作为看板显示名保留。
          </li>
          <li>
            会话标题默认不上传，本机设置
            <code className="ml-1">KIMI_BRIDGE_INCLUDE_SESSION_TITLES=true</code>
            后才会同步，或设置
            <code className="ml-1">KIMI_BRIDGE_ALLOW_REMOTE_THREAD_TITLES=true</code>
            让 Web 控制。设置
            <code className="ml-1">KIMI_BRIDGE_WEB_CONFIG=true</code>
            后，「Bridge 设置」可以动态启停、调整 thread 数与并发上限；
            <code className="ml-1">KIMI_MAX_THREADS</code>
            仍是设备本机上限，Web 不能超过它。
          </li>
          <li>
            <code>KIMI_BRIDGE_MODE=yolo</code> 与
            <code className="ml-1">KIMI_BRIDGE_APPROVAL_MODE=accept</code>
            都会扩大自动执行范围。安装器默认拒绝额外权限，请只在可信工作区显式开启。
          </li>
          <li>
            Linux 安装器创建并启动当前用户的
            <code className="mx-1">ai-task-board-kimi-bridge.service</code>。
            Board Connection Token 会从 <code>kimi acp</code> 子进程环境移除；同一 OS
            用户下的进程仍不构成强隔离，敏感部署应使用独立 UID 或 token proxy。
          </li>
        </ul>
      </Section>

      <Section id="antigravity-bridge" title="Antigravity Bridge（Google Antigravity CLI）">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Antigravity Bridge 是独立的设备 companion，通过 Antigravity CLI 官方的
          headless <code>stream-json</code> 接口驱动本机 <code>agy</code>。它不读取
          Google 未公开的会话数据库；请先在「AI 连接」新建平台为 “Antigravity”
          的连接，再由拥有 Antigravity 登录和目标工作区的同一系统用户安装。运行时
          已内嵌在统一 Bridge 包中，不需要安装第二个 npm 包。
        </p>
        <CopyableCodeBlock copyLabel="复制 Antigravity Bridge 安装命令">
          {`npx --yes ${BRIDGE_INSTALL_PACKAGE} setup antigravity`}
        </CopyableCodeBlock>
        <p className="text-sm leading-relaxed text-muted-foreground">
          无交互终端时，提供以下变量运行 <code>setup antigravity</code> 同样会安装并
          启动 systemd 服务；未提供 <code>ANTIGRAVITY_WORKING_DIRECTORY</code> 时默认由
          Web 端管理工作目录（安装后到「AI 连接 → Bridge 设置 / 新建项目」添加）；
          也可以显式使用 <code>run antigravity</code> 在前台运行。令牌必须来自独立的
          Antigravity 连接：
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
            白名单；网页新建只发送稳定目录 key，不能注入任意本机路径。设备设置
            <code className="ml-1">ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION=true</code>
            （交互安装选择 Web 管理目录时自动写入）后，目录清单也可以直接在「Bridge
            设置」里由 Web 维护，设备会校验路径存在，「新建项目」下发的目录不存在时
            由设备自动创建。
          </li>
          <li>
            agy headless 没有公开的改名与历史读取接口，因此 Antigravity 连接会隐藏
            Thread 改名，删除 Thread 只移除 Bridge 绑定、保留本机会话文件，也不会导入
            TUI 中既有的会话。Bridge 只管理自己创建的 Thread，清单保存在本机注册表
            （可用 <code>ANTIGRAVITY_REGISTRY_FILE</code> 换路径）。
          </li>
          <li>
            本机设置
            <code className="ml-1">ANTIGRAVITY_BRIDGE_WEB_CONFIG=true</code>
            后，「Bridge 设置」可以动态启停、调整 thread 数与并发上限；
            <code className="ml-1">ANTIGRAVITY_MAX_THREADS</code>
            仍是设备本机上限，Web 不能超过它。单次执行时长可用
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
            Linux 安装器创建并启动当前用户的
            <code className="mx-1">ai-task-board-antigravity-bridge.service</code>。
            Board Connection Token 会从 <code>agy</code> 子进程环境移除；同一 OS
            用户下的进程仍不构成强隔离，敏感部署应使用独立 UID 或 token proxy。
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
            description="AI 正在等你回答。Codex Bridge 转发的结构化问题会显示为选择框，并保留原 turn 与 claim（Kimi / Antigravity 通道暂不支持结构化问答）；REST/MCP 纯文字提问仍会结束租约，回复后回到原会话队列。"
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
            会。页面通过 Supabase Realtime 订阅任务、消息、事件、会话活动、会话、附件、
            Bridge 工作目录、历史同步和规划笔记等数据的变化并自动更新；断线重连后会补拉
            遗漏事件，另有 30 秒低频轮询兜底，不需要手动刷新。
          </FaqItem>
          <FaqItem question="为什么三个 Bridge 的环境变量数量差很多？">
            三者共享同一组 AI_TASK_BOARD_* 看板变量和各自前缀的工作目录白名单。差异来自
            Agent 能力面：Codex Bridge 要发现并接管本机已存在的 Codex threads，因此多出
            thread 范围（CODEX_THREAD_SCOPE / CODEX_THREAD_ID）、标题、历史同步和 Web
            远程配置等开关；Kimi（ACP）和 Antigravity（agy headless）由 Bridge 按需创建
            会话，没有可接管的本机清单，也就不需要这些变量。权限类变量则直接映射各自 CLI
            的原生模型：Codex 用沙箱加审批组合，Kimi 用 ACP mode，Antigravity 用
            --mode、--dangerously-skip-permissions 和 --sandbox。
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

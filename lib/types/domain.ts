import type {
  AIConnectionRow,
  AISessionRow,
  ArtifactRow,
  Json,
  SessionTurnPlanRow,
  TaskEventRow,
  TaskMessageRow,
  TaskRow,
  TaskStatus,
  TaskUserInputRequestRow,
  SessionActivityRow,
  SessionHistorySync,
} from "@/lib/types/database";
import type { AgentModelCatalogEntry } from "@/lib/codex-models";

export type AIAuthContext = {
  connectionId: string;
  workspaceId: string;
  tokenHash: string;
};

export type AISessionContext = AIAuthContext & {
  sessionId: string;
};

export type ClaimedTask = Pick<
  TaskRow,
  | "id"
  | "title"
  | "description"
  | "acceptance_criteria"
  | "priority"
  | "required_capabilities"
  | "parent_task_id"
  | "root_task_id"
  | "status"
  | "lease_expires_at"
  | "model"
  | "reasoning_effort"
> & { claim_token: string };

export type TaskDetails = {
  task: TaskRow;
  parent: TaskRow | null;
  children: TaskRow[];
  descendants: TaskRow[];
  dependencies: TaskRow[];
  messages: TaskMessageRow[];
  events: TaskEventRow[];
  artifacts: ArtifactRow[];
  input_requests: TaskUserInputRequestRow[];
};

export type TaskUpdates = {
  task_id: string;
  events: TaskEventRow[];
  messages: TaskMessageRow[];
  artifacts: ArtifactRow[];
  next_cursor: number;
};

export type ConnectionTokenResult = {
  connection: Omit<AIConnectionRow, "api_token_hash">;
  token: string;
};

export type RpcObject = Record<string, Json | undefined>;

export type SessionRegistrationResult = {
  session: AISessionRow;
};

export type SessionConnectionSummary = Pick<
  AIConnectionRow,
  | "id"
  | "name"
  | "platform"
  | "last_seen_at"
  | "bridge_version"
  | "revoked_at"
> & {
  /** Latest visible model catalog reported by this connection's local Agent. */
  model_catalog?: AgentModelCatalogEntry[] | null;
  model_catalog_updated_at?: string | null;
};

export type SessionCurrentTaskSummary = Pick<
  TaskRow,
  | "id"
  | "title"
  | "status"
  | "progress_note"
  | "progress_percent_estimate"
  | "updated_at"
  | "awaiting_user_input"
>;

export type SessionListItem = AISessionRow & {
  connection: SessionConnectionSummary;
  current_task: SessionCurrentTaskSummary | null;
  queued_task_count: number;
  /** Latest non-failed model selection submitted through Web management. */
  configured_model: string | null;
  /** Latest non-failed reasoning selection submitted through Web management. */
  configured_reasoning_effort: string | null;
  /** Aggregate delivery state for the selected model / reasoning settings. */
  thread_settings_status: "queued" | "running" | "succeeded" | null;
};

export type SessionActivityItem = Omit<
  SessionActivityRow,
  "id" | "source_order"
> & {
  /** PostgreSQL bigint serialized losslessly for cursors and client keys. */
  id: string;
  /** PostgreSQL bigint serialized losslessly for deterministic source order. */
  source_order: string;
};

export type SessionConversation = {
  session: SessionListItem;
  tasks: TaskRow[];
  messages: TaskMessageRow[];
  input_requests: TaskUserInputRequestRow[];
  events: TaskEventRow[];
  activities: SessionActivityItem[];
  artifacts?: ArtifactRow[];
  history_sync: SessionHistorySync | null;
  pagination: {
    activities: {
      limit: number;
      oldest_cursor: string | null;
      newest_cursor: string | null;
      has_more_older: boolean;
    };
    legacy: {
      limit: number;
      tasks_truncated: boolean;
      messages_truncated: boolean;
      events_truncated: boolean;
    };
  };
};

/** 规划页 Turn 步骤：草稿字段 + 已派发步骤对应任务的实时状态。 */
export type TurnPlanStep = SessionTurnPlanRow & {
  dispatched_task_status: TaskStatus | null;
};

/** 文件浏览页：目录列表中的一个条目。 */
export type FileExplorerEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  modifiedAt: string | null;
};

/** 文件浏览页：目录列表响应。 */
export type FileExplorerDirectory = {
  path: string;
  name: string;
  entries: FileExplorerEntry[];
  truncated: boolean;
};

/** 文件浏览页：候选项目路径。 */
export type FileExplorerProject = {
  name: string;
  path: string;
};

/** 文件浏览页：Bridge 上报的工作目录聚合成的项目（页面顶部项目 Tab 同源）。 */
export type FileExplorerBridgeProject = {
  id: string;
  name: string;
  workingDirectory: string;
  connections: {
    id: string;
    name: string;
    platform: string;
    bridgeVersion: string | null;
  }[];
  /** 工作目录是否位于 Board 服务本机可访问的根目录内。 */
  serverAccessible: boolean;
};

/** 文件浏览页：可浏览根目录、候选项目路径与 Bridge 项目列表。 */
export type FileExplorerProjects = {
  roots: string[];
  projects: FileExplorerProject[];
  bridgeProjects: FileExplorerBridgeProject[];
};

/** 文件浏览页：设备文件命令状态与结果。 */
export type FileDeviceCommand = {
  id: string;
  connectionId: string;
  action: "list" | "read";
  path: string;
  status: "queued" | "running" | "succeeded" | "failed";
  result: FileExplorerDirectory | FilePreview | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

/** 文件浏览页：目录/文件内容来源（服务本机或指定连接的设备 Bridge）。 */
export type FileSource =
  | { kind: "local" }
  | { kind: "device"; connectionId: string };

/** 文件浏览页：单文件预览结果。 */
export type FilePreview =
  | {
      kind: "text";
      name: string;
      path: string;
      size: number;
      modifiedAt: string | null;
      content: string;
      truncated: boolean;
    }
  | {
      kind: "image";
      name: string;
      path: string;
      size: number;
      modifiedAt: string | null;
      mime: string;
      dataUrl: string;
    }
  | {
      kind: "binary";
      name: string;
      path: string;
      size: number | null;
      modifiedAt: string | null;
      mime: string | null;
      reason: string;
    };

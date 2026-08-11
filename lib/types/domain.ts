import type {
  AIConnectionRow,
  AISessionRow,
  ArtifactRow,
  Json,
  TaskEventRow,
  TaskMessageRow,
  TaskRow,
  TaskUserInputRequestRow,
  SessionActivityRow,
  SessionHistorySync,
} from "@/lib/types/database";

export type AIAuthContext = {
  connectionId: string;
  workspaceId: string;
  tokenHash: string;
};

export type AISessionContext = AIAuthContext & {
  sessionId: string;
  /** Defaults to true for rolling compatibility with older Board tests/clients. */
  syncProcessDetails?: boolean;
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
>;

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

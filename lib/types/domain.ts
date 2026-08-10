import type {
  AIConnectionRow,
  AISessionRow,
  ArtifactRow,
  Json,
  TaskEventRow,
  TaskMessageRow,
  TaskRow,
  SessionActivityRow,
} from "@/lib/types/database";

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
>;

export type SessionListItem = AISessionRow & {
  connection: SessionConnectionSummary;
  current_task: SessionCurrentTaskSummary | null;
  queued_task_count: number;
};

export type SessionActivityItem = Omit<SessionActivityRow, "id"> & {
  /** PostgreSQL bigint serialized losslessly for cursors and client keys. */
  id: string;
};

export type SessionConversation = {
  session: SessionListItem;
  tasks: TaskRow[];
  messages: TaskMessageRow[];
  events: TaskEventRow[];
  activities: SessionActivityItem[];
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
